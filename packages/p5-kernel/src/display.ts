// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * MIME bundle for rich display
 */
export interface IMimeBundle {
  [key: string]: any;
}

/**
 * Display request from $$.display()
 */
export interface IDisplayData {
  data: IMimeBundle;
  metadata: Record<string, any>;
  transient?: {
    display_id?: string;
  };
}

/**
 * Callbacks for display operations
 */
export interface IDisplayCallbacks {
  onDisplay?: (data: IDisplayData) => void;
  onClear?: (wait: boolean) => void;
}

/**
 * Display helper class for rich output
 * Provides methods like html(), svg(), png(), etc.
 */
export class DisplayHelper {
  private _displayCallback?: (data: IDisplayData) => void;
  private _clearCallback?: (wait: boolean) => void;
  private _displayId?: string;
  private _result?: IMimeBundle;

  constructor(displayId?: string) {
    this._displayId = displayId;
  }

  /**
   * Set the callbacks for display operations
   */
  setCallbacks(callbacks: IDisplayCallbacks): void {
    this._displayCallback = callbacks.onDisplay;
    this._clearCallback = callbacks.onClear;
  }

  /**
   * Get the result if set via display methods
   */
  getResult(): IMimeBundle | undefined {
    return this._result;
  }

  /**
   * Clear the result
   */
  clearResult(): void {
    this._result = undefined;
  }

  /**
   * Create a new display with optional ID
   * Usage: $$.display('my-id').html('<div>...</div>')
   */
  display(id?: string): DisplayHelper {
    return new DisplayHelper(id);
  }

  /**
   * Display HTML content
   */
  html(content: string): void {
    this._sendDisplay({ 'text/html': content, 'text/plain': content });
  }

  /**
   * Display SVG content
   */
  svg(content: string): void {
    this._sendDisplay({
      'image/svg+xml': content,
      'text/plain': '[SVG Image]'
    });
  }

  /**
   * Display PNG image (base64 encoded)
   */
  png(base64Content: string): void {
    this._sendDisplay({
      'image/png': base64Content,
      'text/plain': '[PNG Image]'
    });
  }

  /**
   * Display JPEG image (base64 encoded)
   */
  jpeg(base64Content: string): void {
    this._sendDisplay({
      'image/jpeg': base64Content,
      'text/plain': '[JPEG Image]'
    });
  }

  /**
   * Display plain text
   */
  text(content: string): void {
    this._sendDisplay({ 'text/plain': content });
  }

  /**
   * Display Markdown content
   */
  markdown(content: string): void {
    this._sendDisplay({ 'text/markdown': content, 'text/plain': content });
  }

  /**
   * Display LaTeX content
   */
  latex(content: string): void {
    this._sendDisplay({ 'text/latex': content, 'text/plain': content });
  }

  /**
   * Display JSON content
   */
  json(content: any): void {
    this._sendDisplay({
      'application/json': content,
      'text/plain': JSON.stringify(content, null, 2)
    });
  }

  /**
   * Display with custom MIME bundle
   */
  mime(mimeBundle: IMimeBundle): void {
    this._sendDisplay(mimeBundle);
  }

  /**
   * Clear the current output
   * @param options.wait If true, wait for new output before clearing
   */
  clear(options: { wait?: boolean } = {}): void {
    if (this._clearCallback) {
      this._clearCallback(options.wait ?? false);
    }
  }

  /**
   * Send display data
   */
  private _sendDisplay(data: IMimeBundle): void {
    const displayData: IDisplayData = {
      data,
      metadata: {},
      transient: this._displayId ? { display_id: this._displayId } : undefined
    };

    if (this._displayCallback) {
      this._displayCallback(displayData);
    } else {
      // Store as result for synchronous return
      this._result = data;
    }
  }
}
