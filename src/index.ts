import { ClassDeclaration, Node, Project, SourceFile, ts } from 'ts-morph';
import SyntaxKind = ts.SyntaxKind;
import EmitHint = ts.EmitHint;
import yargs from 'yargs';

const args = yargs()
	.options("root", {
		demand: true,
	})
	.parseSync();

const projectRoot = args.root;

const project = new Project({
	tsConfigFilePath: `${projectRoot}/packages/backend/tsconfig.json`,
	// skipLoadingLibFiles: true,
});

const files = project.getSourceFiles();

type Report = {
	pos: {
		start: {
			line: number;
			bytes: number;
		},
		end: {
			line: number;
			bytes: number;
		}
	},
	message: string;
	file: string;
}

function createError<T extends Node<R>, R extends ts.Node>(node: T, message: (a: Readonly<T>) => string): Report {
	return {
		pos: {
			start: {
				line: node.getStartLineNumber(),
				bytes: node.getStart(),
			},
			end: {
				line: node.getEndLineNumber(),
				bytes: node.getEnd()
			}
		},
		message: message(node),
		file: node.getSourceFile().getFilePath().toString()
	}
}

function checkClass(c: ClassDeclaration): Report[] {
	const errors: Report[] = [];

	const file = c.getSourceFile();
	const tcx = project.getTypeChecker();

	const extendsClause = c.getExtends();
	if (!extendsClause) return [];

	const inherited = extendsClause.getExpressionIfKind(SyntaxKind.Identifier);
	// console.log(`lookup: ${i?.print()}`)
	if (!inherited) return [];
	const _d = inherited.getDefinitionNodes()//.filter(node => node.getSourceFile().getFilePath().indexOf("node_modules") === -1);
	// console.log(_d.map(e => e.getSourceFile().getFilePath()));
	if (_d.length === 0) throw new Error("not single");

	const d = _d[0].getSourceFile().getFilePath();
	// console.log(d);
	if (d !== `${projectRoot}/packages/backend/src/server/api/endpoint-base.ts`) return [];

	const [meta, _] = extendsClause.getTypeArguments();
	const typeLevelIOFormatInformationRootType = tcx.getTypeAtLocation(meta);

	// console.log("root", typeLevelIOFormatInformationRootType.getText());
	const allowedErrorIdentifiers = typeLevelIOFormatInformationRootType
		.getProperties()
		.filter(s => s.getName() === "errors")
		.map(s => tcx.getTypeOfSymbolAtLocation(s, file))
		.flatMap(s => s.getProperties())
		.map(s => tcx.getTypeOfSymbolAtLocation(s, file).getProperty("id"))
		.filter(x => !!x)
		.map(s => tcx.getTypeOfSymbolAtLocation(s, file))
		.filter(s => s.isStringLiteral())
		// XXX: ts-morph.d.tsの型付けが甘いのでしょうがなくキャスト
		.map(s => s.getLiteralValue() as string);
	console.debug("union count", allowedErrorIdentifiers.length);

	const unionTypeNode = ts.factory.createUnionTypeNode(
		allowedErrorIdentifiers.map(i => ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(i)))
	);
	// いちいち検査するのは面倒なのでunion typeを作って使いまわす
	const unionType = allowedErrorIdentifiers.length > 0 ? tcx.compilerObject.getTypeAtLocation(unionTypeNode) : tcx.compilerObject.getNeverType();

	console.debug("checking", file.getFilePath());
	console.debug("unionType", ts.createPrinter().printNode(EmitHint.Unspecified, unionTypeNode, file.compilerNode.getSourceFile()));

	file.forEachDescendant(a => {
		if (!a.isKind(SyntaxKind.ThrowStatement)) {
			return;
		}

		const e = a.getExpression();
		if (!e.isKind(SyntaxKind.NewExpression)) {
			return;
		}

		const newTarget = e.getExpression().getText();
		console.debug("thrown expression", newTarget);

		if (newTarget !== "ApiError") {
			errors.push(createError(a, () => `instance of ${newTarget} is thrown instead of APIError`));
			return;
		}
		const firstArgument = e.getArguments()[0];
		if (firstArgument === undefined) {
			errors.push(createError(a, () => `invalid constructor argument: arguments are not supplied from call site`));
			return;
		}
		const abb = tcx.getTypeAtLocation(firstArgument).getProperty("id");
		if (abb === undefined) {
			errors.push(createError(a, () => `invalid constructor argument: the first argument is not an object`));
			return;
		}
		const from = tcx.getTypeOfSymbolAtLocation(abb, file);
		console.debug("from", from.getText());
		const assignable = tcx.compilerObject.isTypeAssignableTo(from.compilerType, unionType,);
		console.debug("assignability", assignable);
		if (!assignable) {
			errors.push(createError(a, () => `invalid constructor argument: type of id is not declared in \`meta.errors\` section. consider add it.`));
			return;
		}
	});

	return errors;
}

function checkFile(file: SourceFile): Report[] {
	return file
		.getStatements()
		.filter(s => s.isKind(SyntaxKind.ClassDeclaration))
		.filter(x => !x.isAbstract() && !x.isAmbient() && x.isExported())
		.flatMap(checkClass);
}

function checkFiles(files: Readonly<SourceFile[]>) {
	return files.flatMap(checkFile)
}

checkFiles(files).forEach(report => {
	console.error(`${report.file}:${report.pos.start.line} : ${report.message}`);
});
