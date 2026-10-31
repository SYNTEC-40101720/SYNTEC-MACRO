// Workspace navigation cache behavior around asynchronous analyzer initialization.

const assert = require('node:assert');
const { test } = require('node:test');
const hostRustAnalyzer = require('../src/hostRustAnalyzer');
const {
  installVscodeMock,
  uninstallVscodeMock
} = require('./helpers/vscodeMock');

test('workspace navigation retries files skipped before the analyzer is ready', async () => {
  let analyzerReady = false;
  const uri = {
    fsPath: 'C:\\workspace\\G1000.nc',
    toString: () => 'file:///workspace/G1000.nc'
  };
  installVscodeMock({
    SymbolInformation: class SymbolInformation {
      constructor(name, kind, containerName, location) {
        Object.assign(this, { name, kind, containerName, location });
      }
    },
    SymbolKind: { File: 1, Number: 2, Namespace: 3 },
    workspace: {
      createFileSystemWatcher: () => ({
        onDidChange() {},
        onDidDelete() {},
        dispose() {}
      }),
      findFiles: async () => [uri],
      asRelativePath: () => 'G1000.nc',
      fs: {
        stat: async () => ({ mtime: 1, size: 12 }),
        readFile: async () => Buffer.from('%@MACRO\nN1000;')
      }
    }
  });
  const originalCreateNavOnlyAdapter = hostRustAnalyzer.createNavOnlyAdapter;
  hostRustAnalyzer.createNavOnlyAdapter = () => {
    if (!analyzerReady) return null;
    return () => ({
      navigation: {
        programEntryName: 'G1000',
        macroProgramName: null,
        symbols: [{ name: 'N1000', kind: 'label', line: 1 }],
        calls: []
      }
    });
  };
  delete require.cache[require.resolve('../src/navigationProvider')];
  const navigation = require('../src/navigationProvider');

  try {
    const token = { isCancellationRequested: false };
    assert.deepStrictEqual(await navigation.provideWorkspaceSymbols('G1000', token), []);

    analyzerReady = true;
    const symbols = await navigation.provideWorkspaceSymbols('G1000', token);
    assert.strictEqual(symbols.length, 1);
    assert.strictEqual(symbols[0].name, 'G1000');
  } finally {
    navigation.dispose();
    hostRustAnalyzer.createNavOnlyAdapter = originalCreateNavOnlyAdapter;
    delete require.cache[require.resolve('../src/navigationProvider')];
    uninstallVscodeMock();
  }
});
