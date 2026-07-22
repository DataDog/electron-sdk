export interface ProcessInfo {
  id: string;
  name?: string;
}

export interface ProcessContextEntry {
  id: string;
  role: 'main' | 'renderer';
  name?: string;
}

export class ProcessContext {
  private readonly mainInfo: ProcessInfo;
  private readonly renderers = new Map<number, ProcessInfo>();

  constructor(mainInfo: ProcessInfo) {
    this.mainInfo = mainInfo;
  }

  getMainProcessContext(): ProcessContextEntry {
    return { id: this.mainInfo.id, role: 'main', name: this.mainInfo.name };
  }

  getRendererProcessContext(webContentsId: number): ProcessContextEntry | undefined {
    const info = this.renderers.get(webContentsId);
    if (info === undefined) return undefined;
    return { id: info.id, role: 'renderer', name: info.name };
  }

  setRendererProcess(webContentsId: number, state: ProcessInfo): void {
    this.renderers.set(webContentsId, state);
  }

  deleteRendererProcess(webContentsId: number): void {
    this.renderers.delete(webContentsId);
  }
}
