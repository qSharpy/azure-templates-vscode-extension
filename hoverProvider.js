const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const hoverProvider = {
  provideHover(document, position) {
    const config = vscode.workspace.getConfiguration('azure-templates-navigator');
    const requiredParameterColor = config.get('setRequiredParameterColor');

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
        
        // push parameters into 'parameters' variable to be shown in hover message
        let lines = yamlText.split('\n');
        for (const parameter of yamlObject.parameters) {
          let name = parameter.name;
          const type = parameter.type;
          
          let lineNumber, isRequired;
          try {
            lineNumber = lines.findIndex(line => line.includes("- name: " + name));
            isRequired = lines[lineNumber - 1].includes('# REQUIRED');
          } catch(e) {
            console.error (`Error parsing YAML: ${e.message}`);
          }

          name = (isRequired == true) ? `<span style="color:${requiredParameterColor};">${parameter.name}</span>` : `<span style="color:#c8cdc4;">${parameter.name}</span>`;
          parameters.push(`- **${name}**: ${type}`);
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

vscode.commands.registerCommand('azure-templates-navigator.setRequiredParameterColor', async () => {
  const config = vscode.workspace.getConfiguration('azure-templates-navigator');
  const requiredParameterColor = config.get('setRequiredParameterColor');
  
  const colorList = {
    pink: "#ff69b4",
    blue: "#add8e6",
    green: "#00ff00",
    yellow: "#ffff00",
    orange: "#ffa500",
    purple: "#800080",
    red: "#e84838",
    //tesla deep red is the default color
    tesla: "#c92d35",
    default: "#c92d35"
  };

  const newValue = await vscode.window.showInputBox({
    prompt: `Current value: ${requiredParameterColor}. Enter a new HEX value or choose from list below`,
    placeHolder: 'extra list to choose from: default, random, blue, green, pink, purple, yellow, orange, tesla'
  });

  if (Object.keys(colorList).includes(newValue)) {
    if (newValue === 'default'){
      vscode.window.showInformationMessage(`Color set to default tesla red (${colorList[newValue]})`);
    } else {
        await config.update('setRequiredParameterColor', colorList[newValue], vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Color set to ${newValue} (${colorList[newValue]})`);
    }
    return;
  }

  if(newValue === 'random') {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
      color += letters[Math.floor(Math.random() * 16)];
    }
    await config.update('setRequiredParameterColor', color, vscode.ConfigurationTarget.Global);
    const responses = [
      `Your new shiny color is ${color}`,
      `It's official, your color is ${color}`,
      `Congratulations, you have chosen ${color}`,
      `Awesome, your new color is ${color}`,
      `Say hello to your new color: ${color}`,
      `You have great taste, your color is ${color}`,
      `Exciting news! Your new color is ${color}`,
      `Your style just got better with ${color}`,
      `Get ready to rock your new color: ${color}`,
      `I hope you like your new color: ${color}`,
      `It's time to celebrate your new color: ${color}`,
      `Your new color is making me jealous: ${color}`,
      `Ultimate achievement. Dani Mocanu approved: ${color}`,
      `You just upgraded your style with ${color}`,
      `I'm impressed with your color choice: ${color}`,
      `Your color game is strong: ${color}`,
      `Nice choice, your color is ${color}`,
      `You're going to love your new color: ${color}`,
      `I have a feeling you'll look great in ${color}`,
      `Your color selection is on point: ${color}`,
      `Looking good in ${color}!`
    ];
    const randomIndex = Math.floor(Math.random() * responses.length);
    vscode.window.showInformationMessage(responses[randomIndex]);
    return;
  }


  if(/^#([0-9A-Fa-f]{3}){1,2}$/.test(newValue) == false){
    vscode.window.showInformationMessage(`Not a hex value`);
    return;
  } else {
      await config.update('setRequiredParameterColor', newValue, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Color set to ${newValue}`);
    }
});

module.exports = hoverProvider;
