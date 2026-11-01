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

  const formatterCommand = extension.packageJSON.contributes.commands.find(
    command => command.command === 'syntecMacro.formatWithReview'
  );
  assert.ok(formatterCommand, 'installed extension should contribute the custom formatter command');
  assert.strictEqual(formatterCommand.title, 'Syntec宏程序格式化');
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('syntecMacro.formatWithReview'), 'custom formatter command should be registered');

  process.stdout.write(`Installed VSIX smoke passed: ${EXTENSION_ID}@${extension.packageJSON.version}\n`);
}

module.exports = { run };