const vscode = require('vscode');
const hoverProvider = require('./hoverProvider');

function activate(context) {
  console.log('Hello extension activated');

  const disposable = vscode.languages.registerHoverProvider('yaml', hoverProvider);
  context.subscriptions.push(disposable);
}

function deactivate() {
  console.log('Hello extension deactivated');
}

module.exports = {
  activate,
  deactivate
};
