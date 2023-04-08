const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const hoverProvider = {
  provideHover(document, position) {
    const line = document.lineAt(position);
    const lineText = line.text;
    const pattern = /- template:\s*(.*)/;
    //const pattern = /(?:- )?(templateName|template):?\s*(.*)/;
    const match = pattern.exec(lineText);

    if (match) {
      const filename = match[1];
      //console.log('filename:',filename);
      
      // Depending on whether the filename begins with / or not, change path
      // If starts with / then all good, append workspace path to template path 
      const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
      let filePath;
      if (filename.startsWith('/')) {
        filePath = path.join(workspaceFolder,'/', filename);
      } else {
        // Get the active text editor
        const editor = vscode.window.activeTextEditor;
        const fileUri = editor.document.uri;
        filePath = fileUri.fsPath;
        filePath = path.join(fileUri.fsPath,'../', filename);
      }
      
      console.log('filepath: ',filePath);
      
       // Read the contents of the YAML file
       let yamlText = null;
       try {
         yamlText = fs.readFileSync(filePath, 'utf-8');
       } catch (e) {
         console.error(`Failed to read template: ${e}`);
         vscode.window.showInformationMessage('Failed to read template:',filePath);
         return null;
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
            vscode.window.showInformationMessage("Open template " + filename, 'Open').then(choice => {
              if (choice === 'Open') {
                vscode.workspace.openTextDocument(filePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
              }
            });
            return new vscode.Hover(hoverMarkdown);
        } catch (error) {
            console.error('Failed to create markdown string:', error);
            return null;
        }
      } else {
        const hoverMarkdown = new vscode.MarkdownString("No parameters in template");
        vscode.window.showInformationMessage("No parameters found in template" + filename, 'Open').then(choice => {
          if (choice === 'Open') {
            vscode.workspace.openTextDocument(filePath).then(doc => {
                vscode.window.showTextDocument(doc);
            });
          }
        });

        return new vscode.Hover(hoverMarkdown);
      }

    }
  }
};

module.exports = hoverProvider;
