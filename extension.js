'use strict';

const vscode = require('vscode');
const hoverProvider = require('./hoverProvider');

/**
 * Called once when the extension is first activated.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('[Azure Templates Navigator] Extension activated');

  // Register the hover provider for all YAML files
  const hoverDisposable = vscode.languages.registerHoverProvider(
    { language: 'yaml', scheme: '*' },
    hoverProvider
  );

  // Command: let the user pick a color for required parameters
  const colorCommandDisposable = vscode.commands.registerCommand(
    'azure-templates-navigator.setRequiredParameterColor',
    async () => {
      const config = vscode.workspace.getConfiguration('azure-templates-navigator');
      const current = config.get('requiredParameterColor', '#c92d35');

      const namedColors = {
        default: '#c92d35',
        tesla: '#c92d35',
        red: '#e84838',
        pink: '#ff69b4',
        blue: '#add8e6',
        green: '#00ff00',
        yellow: '#ffff00',
        orange: '#ffa500',
        purple: '#800080',
      };

      const input = await vscode.window.showInputBox({
        title: 'Required Parameter Color',
        prompt: `Current: ${current}. Enter a HEX color (e.g. #ff0000) or a name: ${Object.keys(namedColors).join(', ')}, random`,
        placeHolder: '#c92d35',
        value: current,
      });

      if (input === undefined) return; // user cancelled

      let newColor;

      if (input === 'random') {
        const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
        newColor = `#${hex()}${hex()}${hex()}`;
        vscode.window.showInformationMessage(`Random color set: ${newColor}`);
      } else if (namedColors[input.toLowerCase()]) {
        newColor = namedColors[input.toLowerCase()];
        vscode.window.showInformationMessage(`Color set to ${input} (${newColor})`);
      } else if (/^#([0-9A-Fa-f]{3}){1,2}$/.test(input)) {
        newColor = input;
        vscode.window.showInformationMessage(`Color set to ${newColor}`);
      } else {
        vscode.window.showWarningMessage(`"${input}" is not a valid HEX color or color name.`);
        return;
      }

      await config.update('requiredParameterColor', newColor, vscode.ConfigurationTarget.Global);
    }
  );

  context.subscriptions.push(hoverDisposable, colorCommandDisposable);
}

function deactivate() {
  console.log('[Azure Templates Navigator] Extension deactivated');
}

module.exports = { activate, deactivate };
