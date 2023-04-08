const vscode = require('vscode');
const hoverProvider = require('./hoverProvider');

function activate(context) {
  console.log('Azure Templates Navigator activated');

  const disposable = vscode.languages.registerHoverProvider('yaml', hoverProvider);
  context.subscriptions.push(disposable);
}

function deactivate() {
  console.log('Azure Templates Navigator deactivated');
}

module.exports = {
  activate,
  deactivate
};
