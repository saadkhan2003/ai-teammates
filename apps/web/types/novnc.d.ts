declare module "@novnc/novnc/lib/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(target: Element, url: string, options?: Record<string, unknown>);
    viewOnly: boolean;
    scaleViewport: boolean;
    showDotCursor: boolean;
    focus(): void;
    blur(): void;
    disconnect(): void;
  }
}
