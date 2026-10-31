const assert = require('assert');
const vscode = require('vscode');

const EXTENSION_ID = 'syntec-team.syntec-macro';

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} should be installed in the isolated profile`);
  assert.strictEqual(extension.packageJSON.version, process.env.SYNTEC_SMOKE_EXPECTED_VERSION);
  assert.ok(
    extension.extensionPath.toLowerCase().startsWith(process.env.SYNTEC_SMOKE_EXTENSIONS_DIR.toLowerCase()),
    `extension should load from the isolated extensions directory: ${extension.extensionPath}`
  );

  await extension.activate();
  assert.strictEqual(extension.isActive, true);

  const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'G1000');
  assert.ok(symbols.some(symbol => symbol.name === 'G1000'), 'installed extension should provide workspace symbols');

  const document = await vscode.workspace.openTextDocument({
    language: 'syntec-macro',
    content: '%@MACRO\n#1:=#2+3*4;\nIF #1>=-2 AND#2<>0 THEN\nG200 X1=50.;\nEND_IF;'
  });
  const edits = await vscode.commands.executeCommand(
    'vscode.executeFormatDocumentProvider',
    document.uri,
    { insertSpaces: true, tabSize: 4 }
  );
  assert.ok(edits && edits.length > 0, 'installed extension should provide formatting edits');
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of edits) workspaceEdit.replace(document.uri, edit.range, edit.newText);
  await vscode.workspace.applyEdit(workspaceEdit);
  assert.strictEqual(document.getText(), '%@MACRO\n#1 := #2 + 3 * 4;\nIF #1 >= -2 AND #2 <> 0 THEN\n    G200 X1=50.;\nEND_IF;');

  process.stdout.write(`Installed VSIX smoke passed: ${EXTENSION_ID}@${extension.packageJSON.version}\n`);
}

module.exports = { run };