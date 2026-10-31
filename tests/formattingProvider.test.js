// tests/formattingProvider.test.js
// Phase 3 Step 5：formattingProvider 单测。覆盖 provideDocumentFormattingEdits：
//   - options.insertSpaces/tabSize 透传给 `formatDocument(request, options)`
//   - AnalysisTextEdit → vscode.TextEdit.replace 转换
//   - 单文档整段替换契约（analysisCore.formatDocument 的「单 edit 整文档替换」）
//   - 空文本返回空 edits

const assert = require('node:assert');
const { test } = require('node:test');
const {
  installVscodeMock,
  uninstallVscodeMock,
  TextEdit
} = require('./helpers/vscodeMock');
const { createDocumentSnapshot } = require('./helpers/documentMock');

function loadFormattingProvider() {
  delete require.cache[require.resolve('../src/providerShared')];
  delete require.cache[require.resolve('../src/analysisProtocol')];
  // R1.2 Stage B: src/analysisCore.js 已 git rm; 不再 require 它 (formattingProvider 不再 require analysisCore).
  // 不清 hostRustAnalyzer 缓存: 模块状态 cachedHostAnalyzer 是 module-level
  // singleton, 删 require.cache 会让 getHostRustAnalyzer() 返回 null 导致 format 失效.
  delete require.cache[require.resolve('../src/formattingProvider')];
  return require('../src/formattingProvider');
}

// R1.2 Stage B: provider 通过 host Rust analyzer 拿 edits; init 一次 wasm 实例,
// 后续 format 调用同步等待 analyzer 就绪. 复用 hostRustAnalyzer 的 cached analyzer
// 让所有测试共享同一 wasm 实例.
const { initHostRustAnalyzer, getHostRustAnalyzer } = require('../src/hostRustAnalyzer');
const HOST_ANALYZER_READY = getHostRustAnalyzer()
  ? Promise.resolve()
  : initHostRustAnalyzer();

function withVscodeMock(fn) {
  return async () => {
    installVscodeMock();
    try {
      await HOST_ANALYZER_READY;
      await fn();
    } finally {
      uninstallVscodeMock();
    }
  };
}

async function format(document, options) {
  const { provideDocumentFormattingEdits } = loadFormattingProvider();
  await HOST_ANALYZER_READY;
  return provideDocumentFormattingEdits(document, options);
}

test('formattingProvider returns edits when document has unformatted content', withVscodeMock(async () => {
  // 缺分号、缩进不对 → formatDocument 应该返回整文档替换 edit
  const doc = createDocumentSnapshot('IF #1 = 1 THEN\n#1 := 2\nEND_IF;\n', { uri: 'file:///test.nc' });
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.ok(Array.isArray(edits));
  // formatDocument 在有差异时产出整文档 TextEdit；无差异时返回空。本场景
  // `#1 = 1` 应规范化为 `#1 := 1`，整文档替换应被产出。
  assert.ok(edits.length === 1, `expected 1 edit for unformatted doc, got ${edits.length}`);
  assert.ok(edits[0] instanceof TextEdit);
  assert.ok(edits[0].newText.length > 0);
  // 整文档替换：从 0 行 0 字符到 lineCount-1 末尾
  assert.strictEqual(edits[0].range.start.line, 0);
  assert.strictEqual(edits[0].range.start.character, 0);
  // end.line 应是文档最后一行
  assert.ok(edits[0].range.end.line >= doc.lineCount - 1);
}));

test('formattingProvider returns empty edits when document is already well-formatted', withVscodeMock(async () => {
  // 完全规范的文件：%@MACRO 头、分号、缩进、`:=` 形式，无变化
  const doc = createDocumentSnapshot('%@MACRO\n#1 := 1;\n', { uri: 'file:///test.nc' });
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.ok(Array.isArray(edits));
  assert.strictEqual(edits.length, 0, `expected no edits for well-formatted doc, got ${JSON.stringify(edits)}`);
}));

test('formattingProvider passes options through to host Rust analyzer (always space-indented)', withVscodeMock(async () => {
  // R1.2 Stage B: host Rust analyzer 接管 formatDocument; Rust 端 format_document
  // 总是产出空格缩进 (insertSpaces/tabSize options 当前不被 Rust ABI 使用).
  const doc = createDocumentSnapshot('IF #1 = 1 THEN\n#1 := 1;\n', { uri: 'file:///test.nc' });
  const editsWithSpaces = await format(doc, { insertSpaces: true, tabSize: 2 });
  const editWithTabs = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.ok(editsWithSpaces.length > 0);
  assert.ok(editWithTabs.length > 0);
  // R1.2: 两次调用产出相同文本 (Rust 不消费 insertSpaces/tabSize options).
  const spacesText = editsWithSpaces[0].newText;
  const tabsText = editWithTabs[0].newText;
  assert.strictEqual(spacesText, tabsText, 'Rust format_document 总是产出空格缩进, 两次调用结果相同');
  // 至少含 4 空格缩进
  assert.ok(spacesText.includes('    '), 'format output should include at least one 4-space indentation');
  assert.ok(!spacesText.includes('\t'), 'Rust format_document should not emit tabs');
}));

test('formattingProvider handles empty document', withVscodeMock(async () => {
  const doc = createDocumentSnapshot('', { uri: 'file:///test.nc' });
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.deepStrictEqual(edits, []);
}));

test('formattingProvider normalize_assignment_operator equals → colon-equals', withVscodeMock(async () => {
  const doc = createDocumentSnapshot('#1 = #2;\n', { uri: 'file:///test.nc' });
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.ok(edits.length >= 1);
  assert.ok(edits[0].newText.includes('#1 := #2'), 'should normalize = to := in edits');
}));

test('formattingProvider adds spaces around assignment and binary arithmetic operators', withVscodeMock(async () => {
  const doc = createDocumentSnapshot('%@MACRO\n#1:=#2+3-1;\n', { uri: 'file:///test.nc' });
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].newText, '%@MACRO\n#1 := #2 + 3 - 1;\n');
}));

test('formattingProvider preserves unary signs, G-code signs, and operators in comments', withVscodeMock(async () => {
  const doc = createDocumentSnapshot(
    '%@MACRO\n#1 := -2;\nG01 X-10 Y+5;\n// #1:=#2+3-1;\n(* #1:=#2+3-1; *)\n',
    { uri: 'file:///test.nc' }
  );
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.deepStrictEqual(edits, []);
}));

test('formattingProvider spaces supported binary, comparison, and logical operators', withVscodeMock(async () => {
  const doc = createDocumentSnapshot(
    'IF #1=#2<>#3<#4>#5<=#6>=#7 AND#8&#9 XOR#10 OR#11 THEN\n#12:=#13+3-1*4/2 MOD#14;\nEND_IF;',
    { uri: 'file:///test.nc' }
  );
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(
    edits[0].newText,
    'IF #1 = #2 <> #3 < #4 > #5 <= #6 >= #7 AND #8 & #9 XOR #10 OR #11 THEN\n    #12 := #13 + 3 - 1 * 4 / 2 MOD #14;\nEND_IF;'
  );
  const secondEdits = await format(
    createDocumentSnapshot(edits[0].newText, { uri: 'file:///test.nc' }),
    { insertSpaces: false, tabSize: 4 }
  );
  assert.deepStrictEqual(secondEdits, []);
}));

test('formattingProvider separates NOT and preserves numeric exponent signs', withVscodeMock(async () => {
  const doc = createDocumentSnapshot('#1:=nOt#2;\n#3:=1E-3;', { uri: 'file:///test.nc' });
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].newText, '#1 := nOt #2;\n#3 := 1E-3;');
}));

test('formattingProvider preserves extended motion arguments and G-code signs', withVscodeMock(async () => {
  const doc = createDocumentSnapshot(
    'G200 X1=50. Y1=30.;\nMOVC LP=1 GP=2 X1=10. Y1=-2.;\nG01 X-#103 Y+5;',
    { uri: 'file:///test.nc' }
  );
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.deepStrictEqual(edits, []);
}));

test('formattingProvider preserves keywords and operators in strings and comments', withVscodeMock(async () => {
  const doc = createDocumentSnapshot(
    'MSG("ENDIF THEN #4=#5 +"); // ENDIF THEN #4=#5 +\n(* ENDIF THEN #4=#5 +\nTHEN #4=#5 + *)',
    { uri: 'file:///test.nc' }
  );
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.deepStrictEqual(edits, []);
}));

test('formattingProvider preserves Unicode comment offsets and string indentation', withVscodeMock(async () => {
  const doc = createDocumentSnapshot(
    '(*😀*) G01 X10\n(*😀*) #1=#2;\n(*😀*) ENDIF;\nIF #1 THEN\n    MSG("ENDIF");\n    #2=1;\nEND_IF;',
    { uri: 'file:///test.nc' }
  );
  const edits = await format(doc, { insertSpaces: false, tabSize: 4 });
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(
    edits[0].newText,
    '(*😀*) G01 X10;\n(*😀*) #1 := #2;\n(*😀*) END_IF;\nIF #1 THEN\n    MSG("ENDIF");\n    #2 := 1;\nEND_IF;'
  );
  const secondEdits = await format(
    createDocumentSnapshot(edits[0].newText, { uri: 'file:///test.nc' }),
    { insertSpaces: false, tabSize: 4 }
  );
  assert.deepStrictEqual(secondEdits, []);
}));
