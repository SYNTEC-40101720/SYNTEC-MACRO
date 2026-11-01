// extension.js
// VSCode 扩展主入口：注册各 Provider 与生命周期管理

const vscode = require('vscode');
const packageJson = require('../package.json');
const { LANG_ID } = require('./providerShared');
const { provideCompletionItems } = require('./completionProvider');
const { provideInlineCompletionItems } = require('./inlineCompletionProvider');
const { provideHover } = require('./hoverProvider');
const { provideDefinition } = require('./definitionProvider');
const diagnostics = require('./diagnosticsProvider');
const navigation = require('./navigationProvider');
const { provideDocumentFormattingEdits } = require('./formattingProvider');
// Host analyzer 初始化: await wasm 加载并缓存同步入口供
// formattingProvider/navigationProvider 同步路径调用; 加载未完成或失败时
// 返空 edits/symbols, 不回退 JS. 不阻塞 activate (异步加载), 失败仅日志.
const { initHostRustAnalyzer } = require('./hostRustAnalyzer');
const { checkForUpdate, notifyUpdate } = require('./updateCheck');

let formatReviewSchemeSequence = 0;

function offsetAt(text, position) {
  let offset = 0;
  let line = 0;
  while (line < position.line) {
    const lineEnd = text.indexOf('\n', offset);
    if (lineEnd === -1) return text.length;
    offset = lineEnd + 1;
    line += 1;
  }
  return Math.min(offset + position.character, text.length);
}

function applyTextEdits(text, edits) {
  const descendingEdits = edits.map(edit => ({
    start: offsetAt(text, edit.range.start),
    end: offsetAt(text, edit.range.end),
    newText: edit.newText
  })).sort((first, second) => second.start - first.start || second.end - first.end);

  let formattedText = text;
  for (const edit of descendingEdits) {
    formattedText = formattedText.slice(0, edit.start) + edit.newText + formattedText.slice(edit.end);
  }
  return formattedText;
}

function activate(context) {
  const selector = { language: LANG_ID };

  initHostRustAnalyzer().catch(error => {
    console.warn('[hostRustAnalyzer] 初始化失败, host provider 将返空:', error instanceof Error ? error.message : error);
  });

  // 升级检查（方案 A）：拉 latest.json 对比版本，仅提示不自动安装；
  // 网络失败静默，绝不影响激活。
  const { getConfig } = require('./providerShared');
  checkForUpdate({ getConfig }).then(manifest => {
    if (manifest) return notifyUpdate(vscode, manifest);
  }).catch(() => { /* 升级检查失败不影响主流程 */ });

  // Worker 控制日志输出通道：诊断 worker 的控制消息（wasm 资产加载失败
  // 原因等）转发到这里，便于排障。
  const workerOutputChannel = vscode.window.createOutputChannel('Syntec Macro Worker');
  context.subscriptions.push(workerOutputChannel);
  diagnostics.setWorkerLogSink(message => workerOutputChannel.appendLine(message));

  // Completion
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems
    }, '.', '#')
  );

  // Inline Completion（1.67+）：关键字唯一前缀匹配的 ghost text（Tab 采纳）
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(selector, {
      provideInlineCompletionItems
    })
  );

  // Hover
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, { provideHover })
  );

  // Go-to Definition
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, { provideDefinition })
  );

  // Document Symbols
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: navigation.provideDocumentSymbol })
  );

  // Workspace Symbols
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: navigation.provideWorkspaceSymbols })
  );

  // References
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(selector, { provideReferences: navigation.provideReferences })
  );

  // Diagnostics
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(LANG_ID);
  context.subscriptions.push(diagnosticCollection);
  diagnostics.setDiagnosticCollection(diagnosticCollection);

  // 语言状态项（1.65+）：仅在打开宏文件时出现在编辑器右下语言模式区，
  // 不再占用全局状态栏；详细文本显示当前版本，command 打开 worker 输出通道。
  const languageStatus = vscode.languages.createLanguageStatusItem('syntecMacro.status', selector);
  languageStatus.name = 'Syntec Macro';
  languageStatus.text = `v${packageJson.version}`;
  languageStatus.detail = `新代宏程序扩展 v${packageJson.version}`;
  languageStatus.command = { title: '查看 Worker 日志', command: 'syntecMacro.showWorkerLog' };
  context.subscriptions.push(languageStatus);

  // 诊断帮助：弹出说明并附「查看诊断文档」按钮，直达 docs/诊断规则与修复动作.md
  // 对应 code 详情（Quick Fix 灯泡里说明型 action 的终点）。
  context.subscriptions.push(
    vscode.commands.registerCommand('syntecMacro.showDiagnosticHelp', message => {
      vscode.window.showInformationMessage(message, '查看诊断文档').then(choice => {
        if (choice !== '查看诊断文档') return;
        vscode.commands.executeCommand('markdown.showPreview',
          vscode.Uri.joinPath(context.extensionUri, 'docs', '诊断规则与修复动作.md'));
      });
    })
  );

  // 打开 Worker 控制日志输出通道（语言状态项 command 入口）
  context.subscriptions.push(
    vscode.commands.registerCommand('syntecMacro.showWorkerLog', () => {
      workerOutputChannel.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('syntecMacro.formatWithReview', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== LANG_ID) {
        vscode.window.showInformationMessage('请先打开并激活一个 SYNTEC 宏程序文档。');
        return;
      }

      const document = editor.document;
      const originalText = document.getText();
      const originalVersion = document.version;
      const formatOptions = {
        tabSize: editor.options.tabSize,
        insertSpaces: editor.options.insertSpaces
      };
      const edits = await provideDocumentFormattingEdits(document, formatOptions);
      const formattedText = applyTextEdits(originalText, Array.isArray(edits) ? edits : []);
      const documentMatches = (text, version) => document.getText() === text &&
        (version === undefined || document.version === version);
      const notifyDocumentChanged = () => {
        vscode.window.showInformationMessage('文档内容已发生变化，未覆盖现有内容。请重新运行“Syntec宏程序格式化”。');
      };

      if (!documentMatches(originalText, originalVersion)) {
        notifyDocumentChanged();
        return;
      }

      if (formattedText === originalText) {
        vscode.window.showInformationMessage('格式化结果与当前内容相同，无需保存。');
        return;
      }

      let formattedDocument;
      let reviewProviderDisposable;
      let diffOpenAttempted = false;
      let existingReviewDiffTabs = new Set();
      const isReviewDiffTab = tab => {
        const TabInputTextDiff = vscode.TabInputTextDiff;
        const input = tab?.input;
        return typeof TabInputTextDiff === 'function' &&
          input instanceof TabInputTextDiff &&
          input.original?.toString() === document.uri.toString() &&
          input.modified?.toString() === formattedDocument?.uri?.toString();
      };
      const getReviewDiffTabs = () => {
        const tabGroups = vscode.window.tabGroups;
        if (!tabGroups || typeof vscode.TabInputTextDiff !== 'function') return [];
        return (tabGroups.all || [])
          .flatMap(group => group.tabs || [])
          .filter(isReviewDiffTab);
      };
      const closeReviewDiff = async () => {
        try {
          const tabGroups = vscode.window.tabGroups;
          if (!tabGroups || typeof tabGroups.close !== 'function') return;
          const tabs = (tabGroups.all || [])
            .flatMap(group => [...(group.tabs || [])]);
          for (const tab of tabs) {
            if (!isReviewDiffTab(tab) || existingReviewDiffTabs.has(tab)) continue;
            try {
              await tabGroups.close(tab);
            } catch {}
          }
        } catch {}
      };

      try {
        try {
          const reviewScheme = `syntec-macro-format-review-${++formatReviewSchemeSequence}`;
          const reviewUri = vscode.Uri.parse(`${reviewScheme}:///formatted`);
          reviewProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
            reviewScheme,
            { provideTextDocumentContent: () => formattedText }
          );
          formattedDocument = await vscode.workspace.openTextDocument(reviewUri);
          formattedDocument = await vscode.languages.setTextDocumentLanguage(formattedDocument, LANG_ID);
          existingReviewDiffTabs = new Set(getReviewDiffTabs());
          diffOpenAttempted = true;
          await vscode.commands.executeCommand(
            'vscode.diff',
            document.uri,
            formattedDocument.uri,
            `格式化差异: ${document.fileName}`
          );
        } catch {
          vscode.window.showInformationMessage('显示格式化差异失败，未应用格式化结果。');
          return;
        }

        const choice = await vscode.window.showInformationMessage(
          '格式化结果已在 VS Code 差异视图中打开。右侧为只读预览，请使用“保存并写回原文件”按钮保存，不要对预览使用 Ctrl+S。原文保持不变；取消或关闭不编辑、不保存。',
          { modal: false },
          '保存并写回原文件',
          '取消格式化'
        );

        if (!documentMatches(originalText, originalVersion)) {
          notifyDocumentChanged();
          return;
        }
        if (choice !== '保存并写回原文件') return;

        const replaceDocumentText = async text => {
          const currentText = document.getText();
          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.replace(
            document.uri,
            new vscode.Range(document.positionAt(0), document.positionAt(currentText.length)),
            text
          );
          return vscode.workspace.applyEdit(workspaceEdit);
        };
        const restoreOriginalText = async expectedVersion => {
          const currentText = document.getText();
          if (currentText === originalText) return true;
          if (currentText !== formattedText ||
            (expectedVersion !== undefined && document.version !== expectedVersion)) return false;

          try {
            await replaceDocumentText(originalText);
          } catch {
            return document.getText() === originalText;
          }
          return document.getText() === originalText;
        };
        const notifyApplyFailure = async (message, expectedVersion) => {
          const restored = await restoreOriginalText(expectedVersion);
          vscode.window.showInformationMessage(restored
            ? `${message}原内容已保留。`
            : `${message}文档内容已变化，未覆盖现有内容。`);
        };

        const expectedAppliedVersion = originalVersion === undefined
          ? undefined
          : originalVersion + 1;
        let applied = false;
        try {
          if (!documentMatches(originalText, originalVersion)) {
            notifyDocumentChanged();
            return;
          }
          applied = await replaceDocumentText(formattedText);
        } catch {
          await notifyApplyFailure('应用格式化结果失败。', expectedAppliedVersion);
          return;
        }
        if (!applied || document.getText() !== formattedText) {
          await notifyApplyFailure('应用格式化结果失败。', expectedAppliedVersion);
          return;
        }
        if (expectedAppliedVersion !== undefined && document.version !== expectedAppliedVersion) {
          notifyDocumentChanged();
          return;
        }

        let saved = false;
        let saveFailureReason = '';
        try {
          saved = await document.save();
        } catch (error) {
          saved = false;
          saveFailureReason = error instanceof Error
            ? `保存异常：${error.message}`
            : 'document.save() 抛出异常。';
        }
        if (!saved) {
          vscode.window.showErrorMessage(
            `格式化内容已写回原文件，但尚未保存。右侧为只读预览，不要对预览使用 Ctrl+S；请返回原文件编辑器重试保存。${saveFailureReason || 'document.save() 返回 false。'}`
          );
        }
      } finally {
        if (diffOpenAttempted) await closeReviewDiff();
        reviewProviderDisposable?.dispose();
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(selector, { provideCodeActions: diagnostics.provideCodeActions }, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
  );

  // 初始扫描 + 实时更新
  for (const doc of vscode.workspace.textDocuments) {
    diagnostics.scheduleDiagnostics(doc);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      diagnostics.scheduleDiagnostics(e.document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      diagnostics.scheduleDiagnostics(doc);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('syntecMacro')) return;
      for (const doc of vscode.workspace.textDocuments) {
        diagnostics.scheduleDiagnostics(doc);
      }
    })
  );

  // 激活日志（原全局状态栏已改为 LanguageStatusItem，只在宏文件上下文显示）
  console.info('[syntec-macro] 扩展已激活 v' + packageJson.version);
}

function deactivate() {
  // 各 Provider 自行清理定时器、缓存与 Worker 线程，避免热重载后触发已 dispose 的 collection
  diagnostics.dispose();
  navigation.dispose();
}

module.exports = { activate, deactivate };
