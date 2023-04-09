const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const hoverProvider = {
  provideHover(document, position) {
    const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const line = document.lineAt(position);
    const lineText = line.text;
    const pattern = /- template:\s*(.*)/;
    //const pattern = /(?:- )?(templateName|template):?\s*(.*)/;
    const match = pattern.exec(lineText);

    if (match) {
      const filename = match[1];
      vscode.workspace.getConfiguration().update('workbench.editor.enablePreview', false, vscode.ConfigurationTarget.openTextDocument);

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
      let yamlObject;
      if (yamlText) {
        try{
          
          const options = { schema: yaml.JSON_SCHEMA, json: true };
          yamlObject = yaml.load(yamlText,options);

        } catch (e) {
          if (e instanceof yaml.YAMLException) {
            console.error(`Error parsing YAML: ${e.message}. Error at line ${e.mark.line}.`);
            const hoverMarkdown = new vscode.MarkdownString(`Duplicate mapping at line ${e.mark.line +1}`);
            vscode.window.showInformationMessage("Cannot parse " + filename + ". Duplicated line in the YAML template file. YAML disallows duplicate keys", 'Open').then(choice => {
              if (choice === 'Open') {
                vscode.workspace.openTextDocument(filePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
              }
            });
            return new vscode.Hover(hoverMarkdown);
          } else {
            console.error(`Error: ${e.message}`);
            vscode.window.showInformationMessage("There is an error during YAML loading, cannot parse " + filename, 'Open').then(choice => {
              if (choice === 'Open') {
                vscode.workspace.openTextDocument(filePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
              }
            });
            return null;
          }
        }
        
        let lines = yamlText.split('\n');

        for (const parameter of yamlObject.parameters) {
          const name = parameter.name;
          const type = parameter.type;

          let description;
          let lineNumber, isRequired;

          try {
            lineNumber = lines.findIndex(line => line.includes("- name: " + name));
            isRequired = lines[lineNumber - 1].includes('# REQUIRED');
          } catch(e) {
            console.error (`Error parsing YAML: ${e.message}`);
          }

          description = (isRequired == true) ? '<span style="color:#cc0000;">required</span>' : '';
          parameters.push(`- **${name}**: ${type} ${description}`);

        }

      }
      
      if (parameters.length > 0) {

        vscode.window.showInformationMessage('Open template: ' + filename, 'Open').then(choice => {
          if (choice === 'Open') {
            vscode.workspace.openTextDocument(filePath).then(doc => {
                vscode.window.showTextDocument(doc);
            });
          }
        });

        try {
            const hoverMarkdown = new vscode.MarkdownString(parameters.join('\n'));
            hoverMarkdown.isTrusted = true;

            return new vscode.Hover(hoverMarkdown);
        } catch (error) {
            console.error('Failed to create markdown string:', error);
            return null;
        }
      } else {
        const hoverMarkdown = new vscode.MarkdownString("No parameters in template ");
        vscode.window.showInformationMessage("No parameters found in template " + filename, 'Open').then(choice => {
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
