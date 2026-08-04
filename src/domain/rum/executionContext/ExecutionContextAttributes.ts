export interface ExecutionContextInfo {
  id: string;
  name?: string;
}

export interface ExecutionContextAttributesEntry {
  id: string;
  type: 'main-process' | 'renderer-process';
  name?: string;
}

export class ExecutionContextAttributes {
  private readonly mainInfo: ExecutionContextInfo;
  private readonly renderers = new Map<number, ExecutionContextInfo>();

  constructor(mainInfo: ExecutionContextInfo) {
    this.mainInfo = mainInfo;
  }

  getMainExecutionContext(): ExecutionContextAttributesEntry {
    return { id: this.mainInfo.id, type: 'main-process', name: this.mainInfo.name };
  }

  getRendererExecutionContext(webContentsId: number): ExecutionContextAttributesEntry | undefined {
    const info = this.renderers.get(webContentsId);
    if (info === undefined) return undefined;
    return { id: info.id, type: 'renderer-process', name: info.name };
  }

  setRendererExecutionContext(webContentsId: number, state: ExecutionContextInfo): void {
    this.renderers.set(webContentsId, state);
  }

  deleteRendererExecutionContext(webContentsId: number): void {
    this.renderers.delete(webContentsId);
  }
}
