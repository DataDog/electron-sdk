export interface Frame {
  module: string;
  function: string;
  instruction: string;
  module_offset: string;
  trust: string;
}

export interface CrashReport {
  status: string;
  crash_info: {
    type: string;
    address: string;
    crashing_thread: number | null;
  };
  system_info: {
    os: string;
    cpu: string;
    cpu_info: string;
  };
  crashing_thread?: {
    thread_index: number;
    frame_count: number;
    frames: Frame[];
  };
  thread_count: number;
  threads: {
    thread_index: number;
    frame_count: number;
    frames: Frame[];
  }[];
  module_count: number;
  modules: {
    base_address: string;
    size: number;
    code_file: string;
    code_identifier: string | null;
    debug_file: string | null;
    debug_identifier: string | null;
    version: string | null;
  }[];
}
