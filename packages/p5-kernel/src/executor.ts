// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { parseScript } from 'meriyah';

import { IMimeBundle } from './display';

// Re-export display types
export {
  IMimeBundle,
  IDisplayData,
  IDisplayCallbacks,
  DisplayHelper
} from './display';

/**
 * Configuration for magic imports
 */
export interface IMagicImportsConfig {
  enabled: boolean;
  baseUrl: string;
  enableAutoNpm: boolean;
}

/**
 * Result of making code async
 */
export interface IAsyncCodeResult {
  asyncFunction: () => Promise<any>;
  withReturn: boolean;
}

/**
 * Result of code completion
 */
export interface ICompletionResult {
  matches: string[];
  cursorStart: number;
  cursorEnd?: number;
  status?: string;
}

/**
 * Result of code completeness check
 */
export interface IIsCompleteResult {
  status: 'complete' | 'incomplete' | 'invalid' | 'unknown';
  indent?: string;
}

/**
 * Result of code inspection
 */
export interface IInspectResult {
  found: boolean;
  data: IMimeBundle;
  metadata: Record<string, any>;
}

/**
 * Configuration for the JavaScript executor
 */
export class ExecutorConfig {
  magicImports: IMagicImportsConfig = {
    enabled: true,
    baseUrl: 'https://cdn.jsdelivr.net/',
    enableAutoNpm: true
  };
}

/**
 * JavaScript code executor with advanced features
 */
export class JavaScriptExecutor {
  private config: ExecutorConfig;
  private globalScope: Window;

  constructor(globalScope: Window, config?: ExecutorConfig) {
    this.globalScope = globalScope;
    this.config = config || new ExecutorConfig();
  }

  /**
   * Add code to export top-level variables to global scope
   */
  private addToGlobalThisCode(key: string, identifier = key): string {
    return `globalThis["${key}"] = ${identifier};`;
  }

  /**
   * Replace a section of code with new code
   */
  private replaceCode(
    code: string,
    start: number,
    end: number,
    newCode: string
  ): string {
    return code.substring(0, start) + newCode + code.substring(end);
  }

  /**
   * Add top-level variables to global scope
   */
  private addToGlobalScope(ast: any): string {
    const extraCode: string[] = [];

    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration') {
        const name = node.id.name;
        extraCode.push(`globalThis["${name}"] = ${name};`);
      } else if (node.type === 'VariableDeclaration') {
        const declarations = node.declarations;

        for (const declaration of declarations) {
          const declarationType = declaration.id.type;

          if (declarationType === 'ObjectPattern') {
            // Handle object destructuring: const { a, b } = obj
            for (const prop of declaration.id.properties) {
              const key = prop.key.name;

              if (key === 'default') {
                // Handle: const { default: defaultExport } = await import(url)
                if (prop.value.type === 'Identifier') {
                  const value = prop.value.name;
                  extraCode.push(this.addToGlobalThisCode(value));
                }
              } else {
                extraCode.push(this.addToGlobalThisCode(key));
              }
            }
          } else if (declarationType === 'ArrayPattern') {
            // Handle array destructuring: const [a, b] = arr
            const keys = declaration.id.elements
              .filter((el: any) => el !== null)
              .map((element: any) => element.name);
            for (const key of keys) {
              extraCode.push(this.addToGlobalThisCode(key));
            }
          } else if (declarationType === 'Identifier') {
            extraCode.push(this.addToGlobalThisCode(declaration.id.name));
          }
        }
      }
    }

    return extraCode.join('\n');
  }

  /**
   * Handle the last statement to auto-return if it's an expression
   */
  private handleLastStatement(
    code: string,
    ast: any
  ): {
    withReturn: boolean;
    modifiedUserCode: string;
    extraReturnCode: string;
  } {
    if (ast.body.length === 0) {
      return {
        withReturn: false,
        modifiedUserCode: code,
        extraReturnCode: ''
      };
    }

    const lastNode = ast.body[ast.body.length - 1];

    // If the last node is an expression statement (and not an assignment)
    if (
      lastNode.type === 'ExpressionStatement' &&
      lastNode.expression.type !== 'AssignmentExpression'
    ) {
      const lastNodeExprStart = lastNode.expression.start;
      const lastNodeExprEnd = lastNode.expression.end;
      const lastNodeRestEnd = lastNode.end;

      // Check for semicolon after the expression
      let semicolonFound = false;
      for (let i = lastNodeExprEnd; i < lastNodeRestEnd; i++) {
        if (code[i] === ';') {
          semicolonFound = true;
          break;
        }
      }

      if (!semicolonFound) {
        // Remove the last node from the code
        const modifiedUserCode =
          code.substring(0, lastNodeExprStart) +
          code.substring(lastNodeExprEnd);
        const codeOfLastNode = code.substring(
          lastNodeExprStart,
          lastNodeExprEnd
        );
        const extraReturnCode = `return [${codeOfLastNode}];`;

        return {
          withReturn: true,
          modifiedUserCode,
          extraReturnCode
        };
      }
    }

    return {
      withReturn: false,
      modifiedUserCode: code,
      extraReturnCode: ''
    };
  }

  /**
   * Transform import source with magic imports
   */
  private transformImportSource(source: string): string {
    const noMagicStarts = ['http://', 'https://', 'data:', 'file://', 'blob:'];
    const noEmsEnds = ['.js', '.mjs', '.cjs', '.wasm', '+esm'];

    if (!this.config.magicImports.enabled) {
      return source;
    }

    const baseUrl = this.config.magicImports.baseUrl.endsWith('/')
      ? this.config.magicImports.baseUrl
      : this.config.magicImports.baseUrl + '/';

    const addEms = !noEmsEnds.some(end => source.endsWith(end));
    const emsExtraEnd = addEms ? (source.endsWith('/') ? '+esm' : '/+esm') : '';

    // If the source starts with http/https, don't transform
    if (noMagicStarts.some(start => source.startsWith(start))) {
      return source;
    }

    // If it starts with npm/ or gh/, or auto npm is disabled
    if (
      ['npm/', 'gh/'].some(start => source.startsWith(start)) ||
      !this.config.magicImports.enableAutoNpm
    ) {
      return `${baseUrl}${source}${emsExtraEnd}`;
    }

    // Auto-prefix with npm/
    return `${baseUrl}npm/${source}${emsExtraEnd}`;
  }

  /**
   * Rewrite import statements to dynamic imports
   */
  private rewriteImportStatements(
    code: string,
    ast: any
  ): {
    modifiedUserCode: string;
    codeAddToGlobalScope: string;
  } {
    let modifiedUserCode = code;
    let codeAddToGlobalScope = '';

    // Process imports in reverse order to maintain correct positions
    for (let i = ast.body.length - 1; i >= 0; i--) {
      const node = ast.body[i];

      if (node.type === 'ImportDeclaration') {
        const importSource = this.transformImportSource(node.source.value);

        if (node.specifiers.length === 0) {
          // Side-effect import: import 'module'
          modifiedUserCode = this.replaceCode(
            modifiedUserCode,
            node.start,
            node.end,
            `await import("${importSource}");\n`
          );
        } else {
          let hasDefaultImport = false;
          let defaultImportName = '';
          let hasNamespaceImport = false;
          let namespaceImportName = '';
          const importedNames: string[] = [];
          const localNames: string[] = [];

          // Get imported and local names
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier') {
              if (specifier.imported.name === 'default') {
                hasDefaultImport = true;
                defaultImportName = specifier.local.name;
              } else {
                importedNames.push(specifier.imported.name);
                localNames.push(specifier.local.name);
              }
            } else if (specifier.type === 'ImportDefaultSpecifier') {
              hasDefaultImport = true;
              defaultImportName = specifier.local.name;
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              hasNamespaceImport = true;
              namespaceImportName = specifier.local.name;
            }
          }

          let newCodeOfNode = '';

          if (hasDefaultImport) {
            newCodeOfNode += `const { default: ${defaultImportName} } = await import("${importSource}");\n`;
            codeAddToGlobalScope += this.addToGlobalThisCode(defaultImportName);
          }

          if (hasNamespaceImport) {
            newCodeOfNode += `const ${namespaceImportName} = await import("${importSource}");\n`;
            codeAddToGlobalScope +=
              this.addToGlobalThisCode(namespaceImportName);
          }

          if (importedNames.length > 0) {
            newCodeOfNode += 'const { ';
            for (let j = 0; j < importedNames.length; j++) {
              newCodeOfNode += importedNames[j];
              codeAddToGlobalScope += this.addToGlobalThisCode(
                localNames[j],
                importedNames[j]
              );
              if (j < importedNames.length - 1) {
                newCodeOfNode += ', ';
              }
            }
            newCodeOfNode += ` } = await import("${importSource}");\n`;
          }

          modifiedUserCode = this.replaceCode(
            modifiedUserCode,
            node.start,
            node.end,
            newCodeOfNode
          );
        }
      }
    }

    return {
      modifiedUserCode,
      codeAddToGlobalScope
    };
  }

  /**
   * Convert user code to an async function
   */
  makeAsyncFromCode(code: string): IAsyncCodeResult {
    if (code.length === 0) {
      return {
        asyncFunction: async () => {},
        withReturn: false
      };
    }

    const ast = parseScript(code, {
      ranges: true,
      module: true
    });

    // Add top-level variables to global scope
    let codeAddToGlobalScope = this.addToGlobalScope(ast);

    // Handle last statement / add return if needed
    const { withReturn, modifiedUserCode, extraReturnCode } =
      this.handleLastStatement(code, ast);
    let finalCode = modifiedUserCode;

    // Handle import statements
    const importResult = this.rewriteImportStatements(finalCode, ast);
    finalCode = importResult.modifiedUserCode;
    codeAddToGlobalScope += importResult.codeAddToGlobalScope;

    const combinedCode = `
      ${finalCode}
      ${codeAddToGlobalScope}
      ${extraReturnCode}
    `;

    const asyncFunction = new Function(`
      const afunc = async function() {
        ${combinedCode}
      };
      return afunc;
    `)();

    return {
      asyncFunction,
      withReturn
    };
  }

  /**
   * Get MIME bundle for a value.
   * Supports custom output methods:
   * - _toHtml() for text/html
   * - _toSvg() for image/svg+xml
   * - _toPng() for image/png (base64)
   * - _toJpeg() for image/jpeg (base64)
   * - _toMime() for custom MIME bundle
   * - inspect() for text/plain (Node.js style)
   */
  getMimeBundle(value: any): IMimeBundle {
    // Handle null and undefined
    if (value === null) {
      return { 'text/plain': 'null' };
    }
    if (value === undefined) {
      return { 'text/plain': 'undefined' };
    }

    // Check for custom MIME output methods
    if (typeof value === 'object' && value !== null) {
      const customMime = this.getCustomMimeBundle(value);
      if (customMime) {
        return customMime;
      }
    }

    // Handle primitives
    if (typeof value === 'string') {
      // Check if it looks like HTML
      if (value.trim().startsWith('<') && value.trim().endsWith('>')) {
        return {
          'text/html': value,
          'text/plain': value
        };
      }
      return { 'text/plain': `'${value}'` };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return { 'text/plain': String(value) };
    }

    // Handle Symbol
    if (typeof value === 'symbol') {
      return { 'text/plain': value.toString() };
    }

    // Handle BigInt
    if (typeof value === 'bigint') {
      return { 'text/plain': `${value.toString()}n` };
    }

    // Handle functions
    if (typeof value === 'function') {
      const funcString = value.toString();
      const name = value.name || 'anonymous';
      return {
        'text/plain': `[Function: ${name}]`,
        'text/html': `<pre style="margin:0"><code>${this.escapeHtml(funcString)}</code></pre>`
      };
    }

    // Handle Error objects
    if (value instanceof Error) {
      return {
        'text/plain': value.stack || value.toString(),
        'application/json': {
          name: value.name,
          message: value.message,
          stack: value.stack
        }
      };
    }

    // Handle Date objects
    if (value instanceof Date) {
      return {
        'text/plain': value.toISOString(),
        'application/json': value.toISOString()
      };
    }

    // Handle RegExp objects
    if (value instanceof RegExp) {
      return { 'text/plain': value.toString() };
    }

    // Handle Map
    if (value instanceof Map) {
      const entries = Array.from(value.entries());
      try {
        return {
          'text/plain': `Map(${value.size}) { ${entries.map(([k, v]) => `${String(k)} => ${String(v)}`).join(', ')} }`,
          'application/json': Object.fromEntries(entries)
        };
      } catch {
        return { 'text/plain': `Map(${value.size})` };
      }
    }

    // Handle Set
    if (value instanceof Set) {
      const items = Array.from(value);
      try {
        return {
          'text/plain': `Set(${value.size}) { ${items.map(v => String(v)).join(', ')} }`,
          'application/json': items
        };
      } catch {
        return { 'text/plain': `Set(${value.size})` };
      }
    }

    // Handle DOM elements (Canvas, HTMLElement, etc.)
    if (this.isDOMElement(value)) {
      return this.getDOMElementMimeBundle(value);
    }

    // Handle p5.js Graphics object
    if (this.isP5Graphics(value)) {
      return this.getP5GraphicsMimeBundle(value);
    }

    // Handle arrays
    if (Array.isArray(value)) {
      try {
        const preview = this.formatArrayPreview(value);
        return {
          'application/json': value,
          'text/plain': preview
        };
      } catch {
        return { 'text/plain': `Array(${value.length})` };
      }
    }

    // Handle typed arrays
    if (ArrayBuffer.isView(value)) {
      const typedArray = value as unknown as { length: number };
      return {
        'text/plain': `${value.constructor.name}(${typedArray.length})`
      };
    }

    // Handle Promise (show as pending)
    if (value instanceof Promise) {
      return { 'text/plain': 'Promise { <pending> }' };
    }

    // Handle generic objects
    if (typeof value === 'object') {
      // Check if it's already a mime bundle
      if ('data' in value && typeof value.data === 'object') {
        return value.data;
      }

      try {
        const preview = this.formatObjectPreview(value);
        return {
          'application/json': value,
          'text/plain': preview
        };
      } catch {
        // Object might have circular references or be non-serializable
        return { 'text/plain': this.formatNonSerializableObject(value) };
      }
    }

    // Fallback
    return { 'text/plain': String(value) };
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => htmlEscapes[char]);
  }

  /**
   * Get custom MIME bundle from object methods.
   * Checks for _toHtml, _toSvg, _toPng, _toJpeg, _toMime, inspect
   */
  private getCustomMimeBundle(value: any): IMimeBundle | null {
    const bundle: IMimeBundle = {};
    let hasCustomOutput = false;

    // Check for _toMime() - returns full MIME bundle
    if (typeof value._toMime === 'function') {
      try {
        const mimeResult = value._toMime();
        if (mimeResult && typeof mimeResult === 'object') {
          return mimeResult;
        }
      } catch {
        // Ignore errors in custom methods
      }
    }

    // Check for _toHtml()
    if (typeof value._toHtml === 'function') {
      try {
        const html = value._toHtml();
        if (typeof html === 'string') {
          bundle['text/html'] = html;
          hasCustomOutput = true;
        }
      } catch {
        // Ignore errors
      }
    }

    // Check for _toSvg()
    if (typeof value._toSvg === 'function') {
      try {
        const svg = value._toSvg();
        if (typeof svg === 'string') {
          bundle['image/svg+xml'] = svg;
          hasCustomOutput = true;
        }
      } catch {
        // Ignore errors
      }
    }

    // Check for _toPng() - should return base64 string
    if (typeof value._toPng === 'function') {
      try {
        const png = value._toPng();
        if (typeof png === 'string') {
          bundle['image/png'] = png;
          hasCustomOutput = true;
        }
      } catch {
        // Ignore errors
      }
    }

    // Check for _toJpeg() - should return base64 string
    if (typeof value._toJpeg === 'function') {
      try {
        const jpeg = value._toJpeg();
        if (typeof jpeg === 'string') {
          bundle['image/jpeg'] = jpeg;
          hasCustomOutput = true;
        }
      } catch {
        // Ignore errors
      }
    }

    // Check for _toMarkdown()
    if (typeof value._toMarkdown === 'function') {
      try {
        const md = value._toMarkdown();
        if (typeof md === 'string') {
          bundle['text/markdown'] = md;
          hasCustomOutput = true;
        }
      } catch {
        // Ignore errors
      }
    }

    // Check for _toLatex()
    if (typeof value._toLatex === 'function') {
      try {
        const latex = value._toLatex();
        if (typeof latex === 'string') {
          bundle['text/latex'] = latex;
          hasCustomOutput = true;
        }
      } catch {
        // Ignore errors
      }
    }

    // Add text/plain representation
    if (hasCustomOutput) {
      // Use custom inspect() if available, otherwise use toString()
      if (typeof value.inspect === 'function') {
        try {
          bundle['text/plain'] = value.inspect();
        } catch {
          bundle['text/plain'] = String(value);
        }
      } else {
        bundle['text/plain'] = String(value);
      }
      return bundle;
    }

    return null;
  }

  /**
   * Check if value is a DOM element
   */
  private isDOMElement(value: any): boolean {
    return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement;
  }

  /**
   * Check if value is a p5.js Graphics object
   */
  private isP5Graphics(value: any): boolean {
    return (
      value &&
      typeof value === 'object' &&
      value.constructor?.name === 'p5.Graphics' &&
      typeof value.elt !== 'undefined'
    );
  }

  /**
   * Get MIME bundle for DOM elements
   */
  private getDOMElementMimeBundle(element: HTMLElement): IMimeBundle {
    // For canvas elements, try to get image data
    if (element instanceof HTMLCanvasElement) {
      try {
        const dataUrl = element.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        return {
          'image/png': base64,
          'text/plain': `<canvas width="${element.width}" height="${element.height}">`
        };
      } catch {
        return { 'text/plain': element.outerHTML };
      }
    }

    // For other elements, return HTML
    return {
      'text/html': element.outerHTML,
      'text/plain': element.outerHTML
    };
  }

  /**
   * Get MIME bundle for p5.js Graphics objects
   */
  private getP5GraphicsMimeBundle(graphics: any): IMimeBundle {
    try {
      const canvas = graphics.elt as HTMLCanvasElement;
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      return {
        'image/png': base64,
        'text/plain': `p5.Graphics(${canvas.width}x${canvas.height})`
      };
    } catch {
      return { 'text/plain': 'p5.Graphics' };
    }
  }

  /**
   * Format array preview with truncation
   */
  private formatArrayPreview(arr: any[], maxItems: number = 10): string {
    if (arr.length === 0) {
      return '[]';
    }
    const items = arr.slice(0, maxItems).map(item => {
      if (item === null) {
        return 'null';
      }
      if (item === undefined) {
        return 'undefined';
      }
      if (typeof item === 'string') {
        return `'${item}'`;
      }
      if (typeof item === 'object') {
        if (Array.isArray(item)) {
          return `Array(${item.length})`;
        }
        return '{...}';
      }
      return String(item);
    });
    const suffix = arr.length > maxItems ? `, ... (${arr.length} items)` : '';
    return `[${items.join(', ')}${suffix}]`;
  }

  /**
   * Format object preview with truncation
   */
  private formatObjectPreview(obj: object, maxProps: number = 5): string {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return '{}';
    }
    const constructor = obj.constructor?.name;
    const prefix =
      constructor && constructor !== 'Object' ? `${constructor} ` : '';

    const props = keys.slice(0, maxProps).map(key => {
      try {
        const value = (obj as any)[key];
        let valueStr: string;
        if (value === null) {
          valueStr = 'null';
        } else if (value === undefined) {
          valueStr = 'undefined';
        } else if (typeof value === 'string') {
          valueStr = `'${value.length > 20 ? value.substring(0, 20) + '...' : value}'`;
        } else if (typeof value === 'object') {
          valueStr = Array.isArray(value) ? `Array(${value.length})` : '{...}';
        } else if (typeof value === 'function') {
          valueStr = '[Function]';
        } else {
          valueStr = String(value);
        }
        return `${key}: ${valueStr}`;
      } catch {
        return `${key}: <error>`;
      }
    });

    const suffix = keys.length > maxProps ? ', ...' : '';
    return `${prefix}{ ${props.join(', ')}${suffix} }`;
  }

  /**
   * Format non-serializable object (circular refs, etc.)
   */
  private formatNonSerializableObject(obj: object): string {
    const constructor = obj.constructor?.name || 'Object';
    const keys = Object.keys(obj);
    return `${constructor} { ${keys.length} properties }`;
  }

  /**
   * Complete code at cursor position
   */
  completeLine(
    codeLine: string,
    globalScope: any = this.globalScope
  ): ICompletionResult {
    // Remove unwanted left part
    const stopChars = ' {}()=+-*/%&|^~<>,:;!?@#';
    let codeBegin = 0;
    for (let i = codeLine.length - 1; i >= 0; i--) {
      if (stopChars.includes(codeLine[i])) {
        codeBegin = i + 1;
        break;
      }
    }

    const pseudoExpression = codeLine.substring(codeBegin);

    // Find part right of dot/bracket
    const expStopChars = '.]';
    let splitPos = pseudoExpression.length;
    let found = false;

    for (let i = splitPos - 1; i >= 0; i--) {
      if (expStopChars.includes(pseudoExpression[i])) {
        splitPos = i;
        found = true;
        break;
      }
    }

    let rootObjectStr = '';
    let toMatch = pseudoExpression;
    let cursorStart = codeBegin;

    if (found) {
      rootObjectStr = pseudoExpression.substring(0, splitPos);
      toMatch = pseudoExpression.substring(splitPos + 1);
      cursorStart += splitPos + 1;
    }

    // Find root object
    let rootObject = globalScope;
    if (rootObjectStr !== '') {
      try {
        const evalFunc = new Function(
          'scope',
          `with(scope) { return ${rootObjectStr}; }`
        );
        rootObject = evalFunc(globalScope);
      } catch {
        return {
          matches: [],
          cursorStart,
          status: 'error'
        };
      }
    }

    const matches: string[] = [];

    // Loop over all properties
    try {
      for (const key in rootObject) {
        if (key.startsWith(toMatch)) {
          matches.push(key);
        }
      }
    } catch {
      // Ignore errors accessing properties
    }

    return {
      matches,
      cursorStart
    };
  }

  /**
   * Complete request with multi-line support
   */
  completeRequest(code: string, cursorPos: number): ICompletionResult {
    const lines = code.split('\n');

    // Find line the cursor is on
    let lineIndex = 0;
    let cursorPosInLine = 0;
    let lineBegin = 0;

    for (let i = 0; i < lines.length; i++) {
      if (cursorPos >= lineBegin && cursorPos <= lineBegin + lines[i].length) {
        lineIndex = i;
        cursorPosInLine = cursorPos - lineBegin;
        break;
      }
      lineBegin += lines[i].length + 1; // +1 for \n
    }

    const codeLine = lines[lineIndex];

    // Only match if cursor is at the end of the line
    if (cursorPosInLine !== codeLine.length) {
      return {
        matches: [],
        cursorStart: cursorPos,
        cursorEnd: cursorPos
      };
    }

    const lineRes = this.completeLine(codeLine);
    const matches = lineRes.matches;
    const inLineCursorStart = lineRes.cursorStart;

    return {
      matches,
      cursorStart: lineBegin + inLineCursorStart,
      cursorEnd: cursorPos,
      status: lineRes.status || 'ok'
    };
  }

  /**
   * Clean stack trace to remove internal frames
   */
  cleanStackTrace(error: Error): string {
    const errStackStr = error.stack || '';
    const errStackLines = errStackStr.split('\n');
    const usedLines: string[] = [];

    for (const line of errStackLines) {
      // Stop at internal implementation details
      if (
        line.includes('makeAsyncFromCode') ||
        line.includes('new Function') ||
        line.includes('asyncFunction')
      ) {
        break;
      }
      usedLines.push(line);
    }

    return usedLines.join('\n');
  }

  /**
   * Check if code is syntactically complete
   * Used for multi-line input in console-style interfaces
   */
  isComplete(code: string): IIsCompleteResult {
    if (code.trim().length === 0) {
      return { status: 'complete' };
    }

    try {
      parseScript(code, {
        ranges: true,
        module: true
      });
      return { status: 'complete' };
    } catch (e: any) {
      const message = e.message || '';

      // Common patterns indicating incomplete code
      const incompletePatterns = [
        /unexpected end of input/i,
        /unterminated string/i,
        /unterminated template/i,
        /unexpected token.*eof/i,
        /expected.*but.*end/i
      ];

      for (const pattern of incompletePatterns) {
        if (pattern.test(message)) {
          // Determine indentation for next line
          const lines = code.split('\n');
          const lastLine = lines[lines.length - 1];
          const currentIndent = lastLine.match(/^(\s*)/)?.[1] || '';

          // Add more indent if we're opening a block
          const opensBlock = /[{([]$/.test(lastLine.trim());
          const indent = opensBlock ? currentIndent + '  ' : currentIndent;

          return { status: 'incomplete', indent };
        }
      }

      // Syntax error that's not about incompleteness
      return { status: 'invalid' };
    }
  }

  /**
   * Inspect an object at the cursor position
   * Returns documentation/type information for tooltips
   */
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: number = 0
  ): IInspectResult {
    // Extract the word/expression at cursor position
    const expression = this.extractExpressionAtCursor(code, cursorPos);

    if (!expression) {
      return {
        found: false,
        data: {},
        metadata: {}
      };
    }

    try {
      // Try to evaluate the expression in the global scope
      const evalFunc = new Function(
        'scope',
        `with(scope) { return ${expression}; }`
      );
      const value = evalFunc(this.globalScope);

      // Build inspection data
      const inspectionData = this.buildInspectionData(
        expression,
        value,
        detailLevel
      );

      return {
        found: true,
        data: inspectionData,
        metadata: {}
      };
    } catch {
      // Try to provide info even if we can't evaluate
      return this.inspectBuiltin(expression, detailLevel);
    }
  }

  /**
   * Extract the expression at the cursor position
   */
  private extractExpressionAtCursor(
    code: string,
    cursorPos: number
  ): string | null {
    // Find word boundaries around cursor
    const beforeCursor = code.substring(0, cursorPos);
    const afterCursor = code.substring(cursorPos);

    // Match identifier characters going backwards
    const beforeMatch = beforeCursor.match(/[\w.$]+$/);
    const afterMatch = afterCursor.match(/^[\w]*/);

    if (!beforeMatch) {
      return null;
    }

    return beforeMatch[0] + (afterMatch?.[0] || '');
  }

  /**
   * Build rich inspection data for a value
   */
  private buildInspectionData(
    expression: string,
    value: any,
    detailLevel: number
  ): IMimeBundle {
    const lines: string[] = [];

    // Type information
    const type = this.getTypeString(value);
    lines.push(`**${expression}**: \`${type}\``);
    lines.push('');

    // Value preview
    if (typeof value === 'function') {
      const funcStr = value.toString();
      const signature = this.extractFunctionSignature(funcStr);
      lines.push('**Signature:**');
      lines.push('```javascript');
      lines.push(signature);
      lines.push('```');

      if (detailLevel > 0) {
        lines.push('');
        lines.push('**Source:**');
        lines.push('```javascript');
        lines.push(funcStr);
        lines.push('```');
      }
    } else if (typeof value === 'object' && value !== null) {
      // List properties
      const props = Object.keys(value).slice(0, 20);
      if (props.length > 0) {
        lines.push('**Properties:**');
        for (const prop of props) {
          try {
            const propType = this.getTypeString(value[prop]);
            lines.push(`- \`${prop}\`: ${propType}`);
          } catch {
            lines.push(`- \`${prop}\`: (inaccessible)`);
          }
        }
        if (Object.keys(value).length > 20) {
          lines.push(`- ... and ${Object.keys(value).length - 20} more`);
        }
      }
    } else {
      lines.push(`**Value:** \`${String(value)}\``);
    }

    return {
      'text/plain': lines.join('\n').replace(/\*\*/g, ''),
      'text/markdown': lines.join('\n')
    };
  }

  /**
   * Get a human-readable type string for a value
   */
  private getTypeString(value: any): string {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (Array.isArray(value)) {
      return `Array(${value.length})`;
    }
    if (typeof value === 'function') {
      const name = value.name || 'anonymous';
      return `function ${name}()`;
    }
    if (typeof value === 'object') {
      const constructor = value.constructor?.name;
      return constructor || 'Object';
    }
    return typeof value;
  }

  /**
   * Extract function signature from function string
   */
  private extractFunctionSignature(funcStr: string): string {
    // Try to extract just the signature
    const match = funcStr.match(
      /^(async\s+)?function\s*(\w*)\s*\([^)]*\)|^(async\s+)?\([^)]*\)\s*=>|^(async\s+)?(\w+)\s*=>/
    );
    if (match) {
      return match[0];
    }
    // For methods and short functions, return first line
    const firstLine = funcStr.split('\n')[0];
    return firstLine.length > 100
      ? firstLine.substring(0, 100) + '...'
      : firstLine;
  }

  /**
   * Provide inspection info for built-in objects
   */
  private inspectBuiltin(
    expression: string,
    _detailLevel: number
  ): IInspectResult {
    // Common JavaScript built-ins documentation
    const builtins: Record<string, string> = {
      console:
        'The console object provides access to the browser debugging console.',
      Math: 'The Math object provides mathematical constants and functions.',
      JSON: 'The JSON object provides methods for parsing and stringifying JSON.',
      Array:
        'The Array object is used to store multiple values in a single variable.',
      Object: "The Object class represents one of JavaScript's data types.",
      String:
        'The String object is used to represent and manipulate a sequence of characters.',
      Number: 'The Number object is a wrapper object for numeric values.',
      Date: 'The Date object represents a single moment in time.',
      Promise:
        'The Promise object represents the eventual completion of an async operation.',
      Map: 'The Map object holds key-value pairs and remembers the original insertion order.',
      Set: 'The Set object lets you store unique values of any type.',
      // p5.js specific
      createCanvas:
        'Creates a canvas element (p5.js). Usage: createCanvas(width, height)',
      background: 'Sets the background color of the canvas (p5.js).',
      fill: 'Sets the fill color for shapes (p5.js).',
      stroke: 'Sets the stroke color for shapes (p5.js).',
      rect: 'Draws a rectangle (p5.js). Usage: rect(x, y, width, height)',
      ellipse: 'Draws an ellipse (p5.js). Usage: ellipse(x, y, width, height)',
      line: 'Draws a line (p5.js). Usage: line(x1, y1, x2, y2)',
      circle: 'Draws a circle (p5.js). Usage: circle(x, y, diameter)',
      text: 'Draws text to the canvas (p5.js). Usage: text(str, x, y)',
      setup: 'Called once when the program starts (p5.js function).',
      draw: 'Called continuously to update the canvas (p5.js function).',
      mouseX: 'Current horizontal position of the mouse (p5.js).',
      mouseY: 'Current vertical position of the mouse (p5.js).',
      width: 'Width of the canvas (p5.js).',
      height: 'Height of the canvas (p5.js).',
      frameCount:
        'Number of frames displayed since the program started (p5.js).',
      random: 'Returns a random floating-point number (p5.js).',
      noise: 'Returns Perlin noise value (p5.js).',
      map: 'Re-maps a number from one range to another (p5.js).',
      color:
        'Creates a color object (p5.js). Usage: color(r, g, b) or color(gray)',
      push: 'Saves the current drawing style settings (p5.js).',
      pop: 'Restores the drawing style settings saved by push() (p5.js).',
      translate: 'Moves the origin point (p5.js).',
      rotate: 'Rotates around the origin (p5.js).',
      scale: 'Scales the coordinate system (p5.js).'
    };

    const doc = builtins[expression];
    if (doc) {
      return {
        found: true,
        data: {
          'text/plain': `${expression}: ${doc}`,
          'text/markdown': `**${expression}**\n\n${doc}`
        },
        metadata: {}
      };
    }

    return {
      found: false,
      data: {},
      metadata: {}
    };
  }
}
