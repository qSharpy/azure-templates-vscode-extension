const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const hoverProvider = {
  provideHover(document, position, token) {
    const wordRange = document.getWordRangeAtPosition(position);
    const currentWord = document.getText(wordRange);

    if (currentWord === 'hello') {
      console.log('Hello word found in hello.yaml!');
      // Read the contents of the YAML file
      //const filePath = path.join(__dirname, '..', 'hello.yaml');

      const filePath = 'C:/Users/UL93PI/hello.yaml'
      
      let yamlText = null;
      try {
        yamlText = fs.readFileSync(filePath, 'utf-8');
        console.log('Hello.yaml successfully read!');
      } catch (e) {
        console.error(`Failed to read YAML file: ${e}`);
      }

      // Parse the YAML text and create a list of parameter names and types
      const parameters = [];
      if (yamlText) {
        const yamlObject = yaml.load(yamlText);
        if (yamlObject.parameters) {
          console.log('if (yamlObject.parameters) seems to work');
          for (const parameter of yamlObject.parameters) {
            const name = parameter.name || '';
            const type = parameter.type || 'string';
            parameters.push(`- **${name}**: ${type}`);
          }
        }
      }

      if (parameters.length > 0) {
        try {
            console.log('GOOD');
            const hoverMarkdown = new vscode.MarkdownString(parameters.join('\n'));
            return new vscode.Hover(hoverMarkdown);
        } catch (error) {
            console.error('Failed to create MarkdownString:', error);
            return null;
        }
      } else {
        console.log('parameters.length is not greater than 0');
        return null;
      }
    } else {
      return null;
    }
  }
};

module.exports = hoverProvider;
