export interface InitConfiguration {
  proxy: string;
  service: string;
  clientToken: string;
  env?: string;
  version?: string;
}

export interface RumViewEvent {
  type: 'view';
  date: number;
  service: string;
  session: {
    id: string;
  };
  view: {
    id: string;
    name: string;
    url: string;
  };
  application: {
    id: string;
  };
  _dd: {
    format_version: 2;
  };
}
