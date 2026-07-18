import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.env.REDDONE_WORKSPACE || "/workspace");
const typescriptPath = process.env.REDDONE_TYPESCRIPT_PATH || path.join(workspace, "node_modules/typescript/lib/typescript.js");
const typescriptModule = await import(
  pathToFileURL(typescriptPath).href
);
const ts = typescriptModule.default || typescriptModule;
const generatedRoots = [
  path.join(workspace, "src/app/generated"),
  path.join(workspace, "src/components/generated"),
  path.join(workspace, "src/content"),
  path.join(workspace, "public/generated"),
];
const allowedPackages = new Set(["react", "next/image", "next/link"]);
const blockedIdentifiers = new Set([
  "Bun",
  "Buffer",
  "Deno",
  "EventSource",
  "Function",
  "SharedWorker",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "__dirname",
  "__filename",
  "eval",
  "fetch",
  "global",
  "globalThis",
  "process",
  "require",
]);
const blockedProperties = new Set([
  "__proto__",
  "constructor",
  "cookie",
  "dangerouslySetInnerHTML",
  "innerHTML",
  "insertAdjacentHTML",
  "outerHTML",
  "prototype",
  "sendBeacon",
  "srcDoc",
  "write",
  "writeln",
]);
const blockedJsxElements = new Set(["embed", "iframe", "object", "script"]);
const violations = [];

function report(file, node, message, sourceFile) {
  const position = node && sourceFile ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)) : null;
  const location = position ? `${path.relative(workspace, file)}:${position.line + 1}:${position.character + 1}` : path.relative(workspace, file);
  violations.push(`${location} ${message}`);
}

function isWithinGeneratedRoot(candidate) {
  const resolved = path.resolve(candidate);
  return generatedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function assertImport(file, specifier, node, sourceFile) {
  if (allowedPackages.has(specifier)) return;
  let resolved;
  if (specifier.startsWith("@/")) resolved = path.join(workspace, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) resolved = path.resolve(path.dirname(file), specifier);
  else {
    report(file, node, `package import is not allowlisted: ${specifier}`, sourceFile);
    return;
  }
  if (!isWithinGeneratedRoot(resolved)) {
    report(file, node, `import escapes generated roots: ${specifier}`, sourceFile);
  }
}

function scanTypeScript(file, content) {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const diagnostic of sourceFile.parseDiagnostics) {
    report(file, diagnostic.start === undefined ? sourceFile : sourceFile.getTokenAtPosition(diagnostic.start), "source contains a parse error", sourceFile);
  }
  if (/\b(?:@ts-ignore|@ts-nocheck|eslint-disable)\b/.test(content)) {
    report(file, sourceFile, "verification-suppression comments are forbidden", sourceFile);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        assertImport(file, node.moduleSpecifier.text, node.moduleSpecifier, sourceFile);
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        report(file, node, "dynamic import is forbidden", sourceFile);
      }
      if (ts.isIdentifier(node.expression) && blockedIdentifiers.has(node.expression.text)) {
        report(file, node.expression, `forbidden call: ${node.expression.text}`, sourceFile);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && blockedIdentifiers.has(node.expression.text)) {
      report(file, node.expression, `forbidden constructor: ${node.expression.text}`, sourceFile);
    }
    if (ts.isIdentifier(node) && blockedIdentifiers.has(node.text)) {
      report(file, node, `forbidden runtime primitive: ${node.text}`, sourceFile);
    }
    if (ts.isPropertyAccessExpression(node) && blockedProperties.has(node.name.text)) {
      report(file, node.name, `forbidden property: ${node.name.text}`, sourceFile);
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      if (blockedProperties.has(node.argumentExpression.text)) {
        report(file, node.argumentExpression, `forbidden property: ${node.argumentExpression.text}`, sourceFile);
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile).toLowerCase();
      if (blockedJsxElements.has(tag)) report(file, node.tagName, `forbidden JSX element: ${tag}`, sourceFile);
      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property)) continue;
        const name = property.name.getText(sourceFile);
        if (blockedProperties.has(name)) report(file, property.name, `forbidden JSX attribute: ${name}`, sourceFile);
        if (property.initializer && ts.isStringLiteral(property.initializer)) {
          const value = property.initializer.text.trim();
          if (/^(?:javascript|data:text\/html):/i.test(value)) {
            report(file, property.initializer, "active URL scheme is forbidden", sourceFile);
          }
          if (/^(?:src|action|formAction)$/i.test(name) && /^https?:\/\//i.test(value)) {
            report(file, property.initializer, "remote JSX resource or form target is forbidden", sourceFile);
          }
        }
      }
    }
    if (ts.isStringLiteralLike(node) && /(?:javascript:|data:text\/html|url\(\s*["']?https?:\/\/)/i.test(node.text)) {
      report(file, node, "active or remote-resource string is forbidden", sourceFile);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function scanTextAsset(file, content) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".css" && /@import\b|expression\s*\(|url\(\s*["']?(?:https?:|javascript:|data:text\/html)|-moz-binding\b/i.test(content)) {
    report(file, null, "CSS contains an external import or active-content primitive", null);
  }
  if (extension === ".svg" && /<\s*(?:script|foreignObject)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|javascript:|data:text\/html)/i.test(content)) {
    report(file, null, "SVG contains active or remote content", null);
  }
  if ([".md", ".json"].includes(extension) && /<\s*(?:script|iframe|object|embed)\b|javascript:/i.test(content)) {
    report(file, null, "content asset contains active HTML", null);
  }
  if (extension === ".json") {
    try {
      JSON.parse(content);
    } catch {
      report(file, null, "JSON content is invalid", null);
    }
  }
}

function assertRoleExtension(file) {
  const relative = path.relative(workspace, file).split(path.sep).join("/");
  const relativeSegments = relative.split("/");
  const extension = path.extname(file).toLowerCase();
  if (relativeSegments.some((segment) => segment === "node_modules" || segment.startsWith("."))) {
    report(file, null, "generated package-resolution and hidden paths are forbidden", null);
  } else if (path.basename(file).toLowerCase() === "package.json") {
    report(file, null, "generated package boundaries are forbidden", null);
  } else if (relative.startsWith("src/app/generated/") && extension !== ".css") {
    report(file, null, "the generated app route root accepts CSS only; routes and server modules are protected", null);
  } else if (relative.startsWith("src/components/generated/") && ![".ts", ".tsx", ".css"].includes(extension)) {
    report(file, null, "generated components accept only TypeScript and CSS", null);
  } else if (relative.startsWith("src/content/") && ![".json", ".md"].includes(extension)) {
    report(file, null, "generated content accepts only JSON and Markdown", null);
  } else if (
    relative.startsWith("public/generated/") &&
    ![".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".woff2", ".json"].includes(extension)
  ) {
    report(file, null, "generated public assets use an unsupported type", null);
  }
}

function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const details = fs.lstatSync(candidate);
    if (details.isSymbolicLink()) {
      report(candidate, null, "symbolic links are forbidden", null);
      continue;
    }
    if (details.isDirectory()) {
      walk(candidate);
      continue;
    }
    if (!details.isFile() || details.nlink !== 1) {
      report(candidate, null, "special files and hard links are forbidden", null);
      continue;
    }
    assertRoleExtension(candidate);
    const extension = path.extname(candidate).toLowerCase();
    if ([".ts", ".tsx", ".css", ".svg", ".md", ".json"].includes(extension)) {
      const content = fs.readFileSync(candidate, "utf8");
      if ([".ts", ".tsx"].includes(extension)) scanTypeScript(candidate, content);
      else scanTextAsset(candidate, content);
    }
  }
}

for (const root of generatedRoots) {
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) {
    report(root, null, "generated root is missing or not a directory", null);
  } else {
    walk(root);
  }
}

if (violations.length > 0) {
  for (const violation of violations.slice(0, 50)) console.error(violation);
  if (violations.length > 50) console.error(`and ${violations.length - 50} more violations`);
  process.exit(1);
}

console.log("AST, import, filesystem, active-content, and egress policy passed");
