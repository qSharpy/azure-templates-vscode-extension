const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const hoverProvider = {
  provideHover(document, position) {
    const line = document.lineAt(position);
    const lineText = line.text;
    const pattern = /- template:\s*(.*)/;
    const match = pattern.exec(lineText);

    if (match) {
      const filename = match[1];
       // Read the contents of the YAML file
       const filePath = path.join(__dirname, '../testcase', filename);
       let yamlText = null;
       try {
         yamlText = fs.readFileSync(filePath, 'utf-8');
         console.log(filePath, 'successfully read!');
       } catch (e) {
         console.error(`Failed to read YAML file: ${e}`);
       }
      
       // Parse the YAML text and create a list of parameter names and types
      const parameters = [];
      if (yamlText) {
        const yamlObject = yaml.load(yamlText);
        if (yamlObject.parameters) {
          for (const parameter of yamlObject.parameters) {
            const name = parameter.name || '';
            const type = parameter.type || 'TYPE NOT SET';
            parameters.push(`- **${name}**: ${type}`);
          }
        }
      }

      if (parameters.length > 0) {
        try {
            const hoverMarkdown = new vscode.MarkdownString(parameters.join('\n'));
            //hoverMarkdown.isTrusted = true;
            vscode.window.showInformationMessage('Click to open template', 'Open').then(choice => {
              if (choice === 'Open') {
                const filePath = path.join(__dirname, '../testcase', filename);
                vscode.workspace.openTextDocument(filePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
              }
            });
            return new vscode.Hover(hoverMarkdown);
        } catch (error) {
            console.error('Failed to create MarkdownString:', error);
            return null;
        }
      } else {
        console.log('parameters.length is not greater than 0');
        return null;
      }

    }
  }
};

module.exports = hoverProvider;
