// formattingProvider.js
// 文档格式化：通过 host Rust analyzer 做保守缩进与规范化
//
// R1.2 Stage B (2026-09-22): JS fallback 路径已移除 — Rust 未就绪时返空 edits.
// 不再 require analysisCore.formatDocument (R1.2 §2.12 将 git rm analysisCore.js).

const vscode = require('vscode');
const {
  createAnalysisRequest,
  createDocumentSnapshot
} = require('./analysisProtocol');
const { getHostRustAnalyzer } = require('./hostRustAnalyzer');

function analyzeDocument(document, formatOptions) {
  const snapshot = createDocumentSnapshot({
    uri: document.uri.toString(),
    version: document.version,
    languageId: document.languageId,
    text: document.getText()
  });
  const request = createAnalysisRequest(snapshot, formatOptions === undefined
    ? {}
    : { formatOptions });
  const hostAnalyzer = getHostRustAnalyzer();
  if (!hostAnalyzer) {
    // Rust 未就绪 (policy='empty'): 返空, 不回退 JS
    return null;
  }
  return hostAnalyzer(request);
}

function toVscodeTextEdit(edit) {
  return vscode.TextEdit.replace(
    new vscode.Range(
      edit.range.start.line,
      edit.range.start.character,
      edit.range.end.line,
      edit.range.end.character
    ),
    edit.newText
  );
}

function provideDocumentFormattingEdits(document, formatOptions) {
  const rustResult = analyzeDocument(document, formatOptions);
  return rustResult ? rustResult.edits.map(toVscodeTextEdit) : [];
}

function splitDocumentLines(text) {
  return text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function provideDocumentRangeFormattingEdits(document, range, formatOptions) {
  const rustResult = analyzeDocument(document, formatOptions);
  if (!rustResult || rustResult.edits.length === 0) return [];

  const sourceLines = splitDocumentLines(document.getText());
  const formattedLines = splitDocumentLines(rustResult.edits[0].newText);
  const lastSelectedLine = range.end.character === 0
    ? range.end.line - 1
    : range.end.line;
  if (lastSelectedLine < range.start.line) return [];

  const edits = [];
  for (let line = range.start.line; line <= lastSelectedLine; line++) {
    const sourceLine = sourceLines[line];
    const formattedLine = formattedLines[line];
    if (sourceLine === undefined || formattedLine === undefined || sourceLine === formattedLine) {
      continue;
    }
    edits.push(vscode.TextEdit.replace(
      new vscode.Range(line, 0, line, sourceLine.length),
      formattedLine
    ));
  }
  return edits;
}

module.exports = {
  provideDocumentFormattingEdits,
  provideDocumentRangeFormattingEdits
};
