// tests/extensionLifecycle.test.js
// Phase 3 Step 6：extension.js activate/deactivate 集成测试。覆盖：
//   - activate 注册全部 8 个 Provider (Completion/InlineCompletion/Hover/
//     Definition/DocumentSymbol/WorkspaceSymbol/References/CodeActions)
//   - createDiagnosticCollection 调用
//   - commands.registerCommand('syntecMacro.showDiagnosticHelp') 调用
//   - statusBar.text 含 package.json 版本号
//   - 各 onDidChange* 事件订阅
//   - deactivate 不抛错

const assert = require('node:assert');
const { test } = require('node:test');
const {
  installVscodeMock,
  uninstallVscodeMock,
  languages,
  commands
} = require('./helpers/vscodeMock');
const packageJson = require('../package.json');

function loadExtension(provideDocumentFormattingEdits) {
  // 清掉 providerShared 与各 Provider 的 require cache 让 activate 流程
  // 再 require 一遍，避免不同测试用例间 mock 状态外泄。
  delete require.cache[require.resolve('../src/providerShared')];
  delete require.cache[require.resolve('../src/diagnosticsProvider')];
  delete require.cache[require.resolve('../src/navigationProvider')];
  delete require.cache[require.resolve('../src/completionProvider')];
  delete require.cache[require.resolve('../src/hoverProvider')];
  delete require.cache[require.resolve('../src/definitionProvider')];
  const formattingProviderPath = require.resolve('../src/formattingProvider');
  delete require.cache[formattingProviderPath];
  if (provideDocumentFormattingEdits) {
    const formattingProvider = require(formattingProviderPath);
    formattingProvider.provideDocumentFormattingEdits = provideDocumentFormattingEdits;
  }
  delete require.cache[require.resolve('../src/extension')];
  return require('../src/extension');
}

function withVscodeMock(fn) {
  return () => {
    installVscodeMock();
    try {
      fn();
    } finally {
      uninstallVscodeMock();
    }
  };
}

function withAsyncVscodeMock(fn) {
  return async () => {
    const vscode = installVscodeMock();
    const originalExecuteCommand = commands.executeCommand;
    const originalActiveTextEditor = vscode.window.activeTextEditor;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalOpenTextDocument = vscode.workspace.openTextDocument;
    const originalRegisterTextDocumentContentProvider = vscode.workspace.registerTextDocumentContentProvider;
    const originalSetTextDocumentLanguage = vscode.languages.setTextDocumentLanguage;
    const originalApplyEdit = vscode.workspace.applyEdit;
    const originalTabGroups = vscode.window.tabGroups;
    const originalTabInputTextDiff = vscode.TabInputTextDiff;
    const originalRegisterCommand = commands.registerCommand;
    try {
      await fn(vscode);
    } finally {
      if (originalExecuteCommand === undefined) delete commands.executeCommand;
      else commands.executeCommand = originalExecuteCommand;
      if (originalActiveTextEditor === undefined) delete vscode.window.activeTextEditor;
      else vscode.window.activeTextEditor = originalActiveTextEditor;
      vscode.window.showInformationMessage = originalShowInformationMessage;
      vscode.window.showQuickPick = originalShowQuickPick;
      if (originalOpenTextDocument === undefined) delete vscode.workspace.openTextDocument;
      else vscode.workspace.openTextDocument = originalOpenTextDocument;
      if (originalRegisterTextDocumentContentProvider === undefined) {
        delete vscode.workspace.registerTextDocumentContentProvider;
      } else {
        vscode.workspace.registerTextDocumentContentProvider = originalRegisterTextDocumentContentProvider;
      }
      if (originalSetTextDocumentLanguage === undefined) delete vscode.languages.setTextDocumentLanguage;
      else vscode.languages.setTextDocumentLanguage = originalSetTextDocumentLanguage;
      if (originalApplyEdit === undefined) delete vscode.workspace.applyEdit;
      else vscode.workspace.applyEdit = originalApplyEdit;
      if (originalTabGroups === undefined) delete vscode.window.tabGroups;
      else vscode.window.tabGroups = originalTabGroups;
      if (originalTabInputTextDiff === undefined) delete vscode.TabInputTextDiff;
      else vscode.TabInputTextDiff = originalTabInputTextDiff;
      commands.registerCommand = originalRegisterCommand;
      uninstallVscodeMock();
    }
  };
}

function activateExtension(provideDocumentFormattingEdits) {
  const { activate } = loadExtension(provideDocumentFormattingEdits);
  const subscriptions = [];
  const context = {
    subscriptions: {
      push(item) { subscriptions.push(item); }
    },
    extensionUri: { scheme: 'file', fsPath: '/ext', _path: '/ext', toString: () => 'file:///ext' }
  };
  activate(context);
  return { subscriptions, context };
}

function createFormattingDocument(content, uri, languageId = 'syntec-macro') {
  let currentContent = content;
  let savedContent = content;
  let currentVersion = 1;
  return {
    uri,
    fileName: 'program.nc',
    languageId,
    get version() { return currentVersion; },
    get isDirty() { return currentContent !== savedContent; },
    getText() { return currentContent; },
    positionAt(offset) {
      const prefix = currentContent.slice(0, Math.max(0, Math.min(offset, currentContent.length)));
      const line = prefix.split('\n').length - 1;
      return { line, character: prefix.length - prefix.lastIndexOf('\n') - 1 };
    },
    setText(nextContent) {
      if (nextContent !== currentContent) currentVersion += 1;
      currentContent = nextContent;
    },
    markSaved() { savedContent = currentContent; }
  };
}

function createFormattingEditor(document, options, calls) {
  return {
    document,
    options,
    async edit(callback) {
      calls.push('edit');
      let replacement;
      callback({ replace(_range, newText) { replacement = newText; } });
      if (replacement !== undefined) document.setText(replacement);
      return true;
    }
  };
}

function stubFormattingProvider(edits) {
  const calls = [];
  return {
    calls,
    provideDocumentFormattingEdits(document, formatOptions) {
      calls.push({ document, formatOptions });
      return edits;
    }
  };
}

function stubReviewDiff(vscode, document) {
  const openTextDocumentCalls = [];
  const openedDocuments = [];
  const contentProviders = [];
  const providedTexts = [];
  const languageCalls = [];
  const providerDisposals = [];
  const diffCalls = [];
  const applyEditCalls = [];
  const closeCalls = [];
  const tabs = [];
  const openedDiffTabs = [];
  const tabListeners = new Set();
  let resolveDiffOpened;
  const diffOpened = new Promise(resolve => { resolveDiffOpened = resolve; });
  const group = { tabs };
  class TabInputTextDiff {
    constructor(original, modified) {
      this.original = original;
      this.modified = modified;
    }
  }

  vscode.TabInputTextDiff = TabInputTextDiff;
  vscode.workspace.registerTextDocumentContentProvider = (scheme, provider) => {
    const registration = { scheme, provider, disposed: false };
    contentProviders.push(registration);
    return {
      dispose() {
        registration.disposed = true;
        providerDisposals.push(registration);
      }
    };
  };
  vscode.workspace.openTextDocument = async uri => {
    openTextDocumentCalls.push(uri);
    const registration = contentProviders.find(candidate => candidate.scheme === uri.scheme);
    const content = registration.provider.provideTextDocumentContent(uri);
    providedTexts.push(content);
    const document = createFormattingDocument(
      content,
      uri,
      'plaintext'
    );
    document.saveCalls = 0;
    document.save = async () => {
      document.saveCalls += 1;
      return true;
    };
    openedDocuments.push(document);
    return document;
  };
  vscode.languages.setTextDocumentLanguage = async (previewDocument, languageId) => {
    languageCalls.push({ document: previewDocument, languageId });
    previewDocument.languageId = languageId;
    return previewDocument;
  };
  vscode.workspace.applyEdit = async workspaceEdit => {
    applyEditCalls.push(workspaceEdit);
    const replacement = workspaceEdit?._ops?.find(operation => operation.kind === 'replace');
    if (!replacement || replacement.uri.toString() !== document.uri.toString()) return false;
    document.setText(replacement.newText);
    return true;
  };
  vscode.window.tabGroups = {
    all: [group],
    onDidChangeTabs(listener) {
      tabListeners.add(listener);
      return { dispose() { tabListeners.delete(listener); } };
    },
    async close(tab) {
      closeCalls.push(tab);
      const index = tabs.indexOf(tab);
      if (index >= 0) tabs.splice(index, 1);
      for (const listener of tabListeners) listener({ closed: [tab], opened: [], changed: [] });
      return true;
    }
  };

  return {
    openTextDocumentCalls,
    openedDocuments,
    contentProviders,
    providedTexts,
    languageCalls,
    providerDisposals,
    diffCalls,
    applyEditCalls,
    closeCalls,
    diffOpened,
    tabs,
    openedDiffTabs,
    addTab(tab) {
      tabs.push(tab);
      return tab;
    },
    addDiffTab(original, modified) {
      const tab = this.addTab({ input: new TabInputTextDiff(original, modified) });
      openedDiffTabs.push(tab);
      return tab;
    },
    openDiff(...args) {
      diffCalls.push(args);
      const tab = this.addDiffTab(args[0], args[1]);
      resolveDiffOpened(tab);
      return tab;
    },
    closeDiffTab(tab) {
      return vscode.window.tabGroups.close(tab);
    }
  };
}

async function waitForFormatReview(reviewDiff) {
  await reviewDiff.diffOpened;
  await new Promise(resolve => setImmediate(resolve));
}

test('activate registers 8 language providers and 1 diagnostic collection', withVscodeMock(() => {
  activateExtension();
  const registerCalls = languages._calls.filter(c => c.kind.startsWith('register'));
  // 8 个 register：Completion/InlineCompletion/Hover/Definition/DocumentSymbol/
  // WorkspaceSymbol/References/CodeActions
  assert.strictEqual(registerCalls.length, 8, `expected 8 register calls, got ${registerCalls.length}: ${registerCalls.map(c => c.kind)}`);
  const registeredKinds = new Set(registerCalls.map(c => c.kind));
  for (const expectedKind of [
    'registerCompletionItemProvider',
    'registerInlineCompletionItemProvider',
    'registerHoverProvider',
    'registerDefinitionProvider',
    'registerDocumentSymbolProvider',
    'registerWorkspaceSymbolProvider',
    'registerReferenceProvider',
    'registerCodeActionsProvider'
  ]) {
    assert.ok(registeredKinds.has(expectedKind), `missing ${expectedKind} register call`);
  }
  assert.ok(!registeredKinds.has('registerDocumentFormattingEditProvider'));
  assert.ok(!registeredKinds.has('registerDocumentRangeFormattingEditProvider'));
  const diagCalls = languages._calls.filter(c => c.kind === 'createDiagnosticCollection');
  assert.strictEqual(diagCalls.length, 1);
  assert.strictEqual(diagCalls[0].name, 'syntec-macro');
}));

test('activate registers syntecMacro.showDiagnosticHelp command', withVscodeMock(() => {
  activateExtension();
  const matching = commands._calls.filter(c => c.commandId === 'syntecMacro.showDiagnosticHelp');
  assert.strictEqual(matching.length, 1);
  assert.strictEqual(typeof matching[0].handler, 'function');
}));

test('activate creates language status item scoped to syntec-macro', withVscodeMock(() => {
  const { subscriptions } = activateExtension();
  const statusCalls = languages._calls.filter(c => c.kind === 'createLanguageStatusItem');
  assert.strictEqual(statusCalls.length, 1, 'exactly one language status item');
  const status = statusCalls[0];
  assert.strictEqual(status.id, 'syntecMacro.status');
  assert.strictEqual(status.selector.language, 'syntec-macro');
  // 项对象应已写入版本文本并进入 subscriptions
  const item = subscriptions.find(s => s && s.id === 'syntecMacro.status');
  assert.ok(item, 'language status item should be pushed into context.subscriptions');
  assert.ok(item.text.includes(packageJson.version), `status.text should include version, got: ${item.text}`);
  assert.ok(item.command && item.command.command === 'syntecMacro.showWorkerLog');
}));

test('activate registers syntecMacro.showWorkerLog command', withVscodeMock(() => {
  activateExtension();
  const matching = commands._calls.filter(c => c.commandId === 'syntecMacro.showWorkerLog');
  assert.strictEqual(matching.length, 1);
  assert.strictEqual(typeof matching[0].handler, 'function');
}));

test('formatWithReview previews without editing and saves only after confirmation', withAsyncVscodeMock(async vscode => {
  const originalText = 'N10  G00 X0\nN20   G00 X1';
  const originalUri = { toString: () => 'file:///program.nc' };
  const document = createFormattingDocument(originalText, originalUri);
  const formattedText = 'N10 G00 X0\nN20 G00 X1';
  const edits = [
    { range: { start: { line: 1, character: 3 }, end: { line: 1, character: 6 } }, newText: ' ' },
    { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } }, newText: ' ' }
  ];
  const commandCalls = [];
  const actions = [];
  const quickPickCalls = [];
  const formattingProvider = stubFormattingProvider(edits);
  let saveCalls = 0;

  activateExtension(formattingProvider.provideDocumentFormattingEdits);
  const editor = createFormattingEditor(document, { tabSize: 6, insertSpaces: false }, actions);
  const reviewDiff = stubReviewDiff(vscode, document);
  const otherTab = reviewDiff.addTab({ input: { label: 'unrelated tab' } });
  vscode.window.activeTextEditor = editor;
  document.save = async () => {
    actions.push('save');
    saveCalls += 1;
    document.markSaved();
    return true;
  };
  vscode.commands.executeCommand = async (commandId, ...args) => {
    commandCalls.push({ commandId, args });
    if (commandId === 'vscode.diff') return reviewDiff.openDiff(...args);
    throw new Error(`unexpected command: ${commandId}`);
  };
  vscode.window.showQuickPick = async (...args) => {
    assert.strictEqual(document.getText(), originalText, 'the original text must remain in the editor before confirmation');
    assert.strictEqual(document.version, 1, 'the document version must not change before confirmation');
    assert.strictEqual(document.isDirty, false, 'the document must remain clean before confirmation');
    assert.deepStrictEqual(actions, [], 'editor.edit must not run before confirmation');
    assert.strictEqual(saveCalls, 0, 'document must not be saved before confirmation');
    assert.deepStrictEqual(args[0].map(item => item.label), ['保存并写回原文件', '取消格式化']);
    assert.deepStrictEqual(args[0].map(item => ({
      icon: item.iconPath.id,
      color: item.iconPath.color.id
    })), [
      { icon: 'save', color: 'charts.green' },
      { icon: 'close', color: 'charts.red' }
    ]);
    assert.deepStrictEqual(args[1], { placeHolder: '格式化预览待处理' });
    assert.strictEqual(reviewDiff.openTextDocumentCalls.length, 1);
    const previewUri = reviewDiff.openTextDocumentCalls[0];
    assert.strictEqual(previewUri.scheme, reviewDiff.contentProviders[0].scheme);
    assert.notStrictEqual(previewUri.scheme, 'untitled');
    assert.deepStrictEqual(reviewDiff.providedTexts, [formattedText]);
    const formattedDocument = reviewDiff.openedDocuments[0];
    assert.strictEqual(formattedDocument.languageId, 'syntec-macro');
    assert.strictEqual(formattedDocument.getText(), formattedText);
    assert.deepStrictEqual(reviewDiff.languageCalls, [{ document: formattedDocument, languageId: 'syntec-macro' }]);
    assert.deepStrictEqual(reviewDiff.diffCalls, [[
      originalUri,
      formattedDocument.uri,
      '格式化差异: program.nc'
    ]]);
    actions.push('confirm');
    quickPickCalls.push(args);
    return args[0][0];
  };

  const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
  const pending = handler();
  await waitForFormatReview(reviewDiff);
  const statusItem = vscode.window._calls.createStatusBarItem.at(-1);
  assert.ok(statusItem._shown);
  assert.strictEqual(statusItem.text, '$(diff) 格式化预览待处理');
  assert.strictEqual(statusItem.command, 'syntecMacro.chooseFormatReviewAction');
  assert.ok(statusItem.tooltip.includes('不要对预览使用 Ctrl+S'));
  assert.ok(statusItem.tooltip.includes('关闭预览会取消'));
  await commands._calls.find(call => call.commandId === 'syntecMacro.chooseFormatReviewAction').handler();
  await pending;

  assert.deepStrictEqual(formattingProvider.calls, [{
    document,
    formatOptions: { tabSize: 6, insertSpaces: false }
  }]);
  assert.deepStrictEqual(commandCalls.map(call => call.commandId).filter(commandId => commandId === 'vscode.diff'), ['vscode.diff']);
  assert.strictEqual(reviewDiff.openTextDocumentCalls.length, 1);
  assert.strictEqual(document.getText(), formattedText);
  assert.strictEqual(document.isDirty, false);
  assert.strictEqual(reviewDiff.openedDocuments[0].saveCalls, 0, 'the temporary formatted document must not be saved');
  assert.strictEqual(quickPickCalls.length, 1);
  assert.ok(!statusItem._shown);
  assert.strictEqual(reviewDiff.applyEditCalls.length, 1);
  assert.strictEqual(reviewDiff.applyEditCalls[0]._ops[0].uri, document.uri);
  assert.deepStrictEqual(actions, ['confirm', 'save']);
  assert.strictEqual(reviewDiff.contentProviders[0].disposed, true);
  assert.deepStrictEqual(reviewDiff.providerDisposals, [reviewDiff.contentProviders[0]]);
  assert.deepStrictEqual(reviewDiff.closeCalls, reviewDiff.openedDiffTabs);
  assert.ok(reviewDiff.tabs.includes(otherTab), 'unrelated tabs must remain open');
}));

test('package contributes format-review actions only to diff editor titles', () => {
  const titleActions = packageJson.contributes.menus['editor/title'];
  assert.deepStrictEqual(titleActions.map(action => action.command), [
    'syntecMacro.saveFormatReview',
    'syntecMacro.cancelFormatReview'
  ]);
  assert.ok(titleActions.every(action => action.when.includes('syntecMacro.formatReviewPending') && action.when.includes('isInDiffEditor')));
});

for (const choice of ['取消格式化', undefined]) {
  test(`formatWithReview leaves the original text untouched when confirmation returns ${choice || 'no choice'}`, withAsyncVscodeMock(async vscode => {
    const originalText = 'N10  G00 X0';
    const document = createFormattingDocument(originalText, { toString: () => 'file:///program.nc' });
    const actions = [];
    const formattingProvider = stubFormattingProvider([{
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
      newText: ' '
    }]);
    const editor = createFormattingEditor(document, { tabSize: 4, insertSpaces: false }, actions);
    const reviewDiff = stubReviewDiff(vscode, document);
    const otherTab = reviewDiff.addTab({ input: { label: 'unrelated tab' } });
    let saveCalls = 0;

    activateExtension(formattingProvider.provideDocumentFormattingEdits);
    vscode.window.activeTextEditor = editor;
    document.save = async () => {
      saveCalls += 1;
      return true;
    };
    vscode.commands.executeCommand = async (commandId, ...args) => {
      if (commandId === 'vscode.diff') return reviewDiff.openDiff(...args);
      return undefined;
    };
    const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
    const pending = handler();
    await waitForFormatReview(reviewDiff);
    assert.strictEqual(document.getText(), originalText);
    assert.strictEqual(document.version, 1);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(actions, []);
    const previewUri = reviewDiff.openTextDocumentCalls[0];
    assert.strictEqual(previewUri.scheme, reviewDiff.contentProviders[0].scheme);
    assert.notStrictEqual(previewUri.scheme, 'untitled');
    assert.deepStrictEqual(reviewDiff.providedTexts, ['N10 G00 X0']);
    assert.strictEqual(reviewDiff.openedDocuments[0].languageId, 'syntec-macro');
    assert.strictEqual(reviewDiff.openedDocuments[0].getText(), 'N10 G00 X0');
    if (choice === undefined) {
      await reviewDiff.closeDiffTab(reviewDiff.openedDiffTabs[0]);
    } else {
      await commands._calls.find(call => call.commandId === 'syntecMacro.cancelFormatReview').handler();
    }
    await pending;

    assert.strictEqual(document.getText(), originalText);
    assert.strictEqual(document.version, 1);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(actions, []);
    assert.strictEqual(saveCalls, 0);
    assert.strictEqual(reviewDiff.applyEditCalls.length, 0);
    assert.strictEqual(reviewDiff.contentProviders[0].disposed, true);
    assert.deepStrictEqual(reviewDiff.providerDisposals, [reviewDiff.contentProviders[0]]);
    assert.deepStrictEqual(reviewDiff.closeCalls, reviewDiff.openedDiffTabs);
    assert.ok(reviewDiff.tabs.includes(otherTab), 'unrelated tabs must remain open');
  }));
}

test('formatWithReview does not overwrite edits made while confirmation is open', withAsyncVscodeMock(async vscode => {
  const originalText = 'N10  G00 X0';
  const concurrentText = 'N10 G01 X5';
  const document = createFormattingDocument(originalText, { toString: () => 'file:///program.nc' });
  const actions = [];
  const formattingProvider = stubFormattingProvider([{
    range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
    newText: ' '
  }]);
  const editor = createFormattingEditor(document, { tabSize: 4, insertSpaces: false }, actions);
  const reviewDiff = stubReviewDiff(vscode, document);
  const otherTab = reviewDiff.addTab({ input: { label: 'unrelated tab' } });
  const messages = [];
  let saveCalls = 0;

  activateExtension(formattingProvider.provideDocumentFormattingEdits);
  vscode.window.activeTextEditor = editor;
  document.save = async () => {
    saveCalls += 1;
    return true;
  };
  vscode.commands.executeCommand = async (commandId, ...args) => {
    if (commandId === 'vscode.diff') return reviewDiff.openDiff(...args);
    return undefined;
  };
  vscode.window.showInformationMessage = message => {
    messages.push(message);
    return Promise.resolve();
  };

  const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
  const pending = handler();
  await waitForFormatReview(reviewDiff);
  document.setText(concurrentText);
  await commands._calls.find(call => call.commandId === 'syntecMacro.saveFormatReview').handler();
  await pending;

  assert.strictEqual(document.getText(), concurrentText);
  assert.strictEqual(document.isDirty, true);
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(saveCalls, 0);
  assert.strictEqual(reviewDiff.applyEditCalls.length, 0);
  assert.ok(messages.some(message => message.includes('请重新运行“Syntec宏程序格式化”。')));
  assert.deepStrictEqual(reviewDiff.closeCalls, reviewDiff.openedDiffTabs);
  assert.ok(reviewDiff.tabs.includes(otherTab), 'unrelated tabs must remain open');
}));

test('formatWithReview does not edit or open a preview when formatting makes no changes', withAsyncVscodeMock(async vscode => {
  const originalText = 'N10 G00 X0';
  const document = createFormattingDocument(originalText, { toString: () => 'file:///program.nc' });
  const actions = [];
  const formattingProvider = stubFormattingProvider([{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: originalText.length } },
    newText: originalText
  }]);

  activateExtension(formattingProvider.provideDocumentFormattingEdits);
  const editor = createFormattingEditor(document, { tabSize: 4, insertSpaces: false }, actions);
  const reviewDiff = stubReviewDiff(vscode, document);
  vscode.window.activeTextEditor = editor;
  document.save = async () => {
    actions.push('save');
    return true;
  };
  vscode.commands.executeCommand = async (commandId, ...args) => {
    if (commandId === 'vscode.diff') return reviewDiff.openDiff(...args);
    return undefined;
  };

  const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
  await handler();

  assert.strictEqual(document.getText(), originalText);
  assert.deepStrictEqual(reviewDiff.diffCalls, []);
  assert.strictEqual(reviewDiff.openTextDocumentCalls.length, 0);
  assert.deepStrictEqual(actions, []);
  assert.ok(vscode.window._calls.showInformationMessage.includes('格式化结果与当前内容相同，无需保存。'));
}));

test('formatWithReview restores the original text when workspace.applyEdit reports failure', withAsyncVscodeMock(async vscode => {
  const originalText = 'N10  G00 X0';
  const formattedText = 'N10 G00 X0';
  const document = createFormattingDocument(originalText, { toString: () => 'file:///program.nc' });
  const messages = [];
  const formattingProvider = stubFormattingProvider([{
    range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
    newText: ' '
  }]);
  let applyEditCalls = 0;
  let saveCalls = 0;

  activateExtension(formattingProvider.provideDocumentFormattingEdits);
  const editor = createFormattingEditor(document, { tabSize: 4, insertSpaces: false }, []);
  const reviewDiff = stubReviewDiff(vscode, document);
  const applyEdit = vscode.workspace.applyEdit;
  vscode.workspace.applyEdit = async workspaceEdit => {
    applyEditCalls += 1;
    const applied = await applyEdit(workspaceEdit);
    return applyEditCalls > 1 && applied;
  };
  vscode.window.activeTextEditor = editor;
  document.save = async () => {
    saveCalls += 1;
    return true;
  };
  vscode.commands.executeCommand = async (commandId, ...args) => {
    if (commandId === 'vscode.diff') return reviewDiff.openDiff(...args);
    return undefined;
  };
  vscode.window.showInformationMessage = async message => {
    messages.push(message);
    return undefined;
  };

  const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
  const pending = handler();
  await waitForFormatReview(reviewDiff);
  await commands._calls.find(call => call.commandId === 'syntecMacro.saveFormatReview').handler();
  await pending;

  assert.strictEqual(document.getText(), originalText);
  assert.strictEqual(document.isDirty, false);
  assert.strictEqual(applyEditCalls, 2);
  assert.strictEqual(saveCalls, 0);
  assert.deepStrictEqual(reviewDiff.applyEditCalls.map(edit => edit._ops[0].newText), [formattedText, originalText]);
  assert.ok(messages.some(message => message.includes('应用格式化结果失败。原内容已保留。')));
  assert.notStrictEqual(document.getText(), formattedText);
  assert.deepStrictEqual(reviewDiff.closeCalls, reviewDiff.openedDiffTabs);
}));

for (const saveFailure of ['false', 'throw']) {
  test(`formatWithReview keeps the confirmed formatting when document.save ${saveFailure === 'false' ? 'returns false' : 'throws'}`, withAsyncVscodeMock(async vscode => {
    const originalText = 'N10  G00 X0';
    const formattedText = 'N10 G00 X0';
    const document = createFormattingDocument(originalText, { toString: () => 'file:///program.nc' });
    const actions = [];
    const formattingProvider = stubFormattingProvider([{
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
      newText: ' '
    }]);
    const editor = createFormattingEditor(document, { tabSize: 4, insertSpaces: false }, actions);
    const reviewDiff = stubReviewDiff(vscode, document);
    const messages = [];
    const errorMessages = [];
    let saveCalls = 0;

    activateExtension(formattingProvider.provideDocumentFormattingEdits);
    vscode.window.activeTextEditor = editor;
    document.save = async () => {
      saveCalls += 1;
      actions.push('save');
      if (saveFailure === 'false') return false;
      throw new Error('save failed');
    };
    vscode.commands.executeCommand = async (commandId, ...args) => {
      if (commandId === 'vscode.diff') return reviewDiff.openDiff(...args);
      return undefined;
    };
    vscode.window.showInformationMessage = async message => {
      messages.push(message);
      return undefined;
    };
    vscode.window.showErrorMessage = async message => {
      errorMessages.push(message);
      return undefined;
    };

    const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
    const pending = handler();
    await waitForFormatReview(reviewDiff);
    await commands._calls.find(call => call.commandId === 'syntecMacro.saveFormatReview').handler();
    await pending;

    assert.strictEqual(document.getText(), formattedText);
    assert.strictEqual(document.isDirty, true);
    assert.strictEqual(saveCalls, 1);
    assert.strictEqual(reviewDiff.applyEditCalls.length, 1);
    assert.deepStrictEqual(actions, ['save']);
    assert.ok(errorMessages.some(message => message.includes('格式化内容已写回原文件，但尚未保存。')));
    assert.ok(errorMessages.some(message => message.includes('右侧为只读预览，不要对预览使用 Ctrl+S')));
    assert.ok(errorMessages.some(message => message.includes('请返回原文件编辑器重试保存。')));
    assert.strictEqual(reviewDiff.openedDocuments[0].saveCalls, 0, 'only the original document may be saved');
    assert.deepStrictEqual(reviewDiff.closeCalls, reviewDiff.openedDiffTabs);
    if (saveFailure === 'false') {
      assert.ok(errorMessages.some(message => message.includes('document.save() 返回 false。')));
    } else {
      assert.ok(errorMessages.some(message => message.includes('save failed')));
    }
  }));
}

test('formatWithReview rejects a non-macro active editor', withAsyncVscodeMock(async vscode => {
  const document = createFormattingDocument('G00 X0', { toString: () => 'file:///program.txt' }, 'plaintext');
  const formattingProvider = stubFormattingProvider([]);

  activateExtension(formattingProvider.provideDocumentFormattingEdits);
  vscode.window.activeTextEditor = { document, options: { tabSize: 4, insertSpaces: true } };

  const handler = commands._calls.find(call => call.commandId === 'syntecMacro.formatWithReview').handler;
  await handler();

  assert.strictEqual(formattingProvider.calls.length, 0);
  assert.ok(vscode.window._calls.showInformationMessage.includes('请先打开并激活一个 SYNTEC 宏程序文档。'));
}));

test('activate subscribes to workspace events and pushes disposables into context', withVscodeMock(() => {
  const { subscriptions } = activateExtension();
  // onDidChangeTextDocument / onDidOpenTextDocument / onDidChangeConfiguration
  // 各返回一个 Disposable，应被推入 subscriptions。
  // 至少 3 个来自 workspace 事件的 Disposable + statusBar + 其它 register 返回
  assert.ok(subscriptions.length >= 11, `expected at least 11 subscriptions (9 providers + command + statusbar + 3 events), got ${subscriptions.length}`);
}));

test('activate logs extension version to console', withVscodeMock(() => {
  // 用 spy 替换 console.info 拦截 activate 日志
  const originalInfo = console.info;
  const messages = [];
  console.info = (...args) => { messages.push(args.join(' ')); };
  try {
    activateExtension();
    const activationMessage = messages.find(m => m.includes('扩展已激活'));
    assert.ok(activationMessage, `expected activation message, got: ${messages.join(' | ')}`);
    assert.ok(activationMessage.includes(packageJson.version));
  } finally {
    console.info = originalInfo;
  }
}));

test('deactivate does not throw', withVscodeMock(() => {
  // 先 activate 让 diagnosticsProvider.setDiagnosticCollection 等内部状态就位，
  // 再 deactivate 调 dispose() 与 navigation.dispose()。
  activateExtension();
  const { deactivate } = loadExtension();
  // deactivate 在没有 worker 实际 spawn 时应不抛错
  assert.doesNotThrow(() => deactivate());
}));
