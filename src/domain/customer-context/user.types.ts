/** User identity and attributes attached to SDK events. */
export interface UserInfo {
  id?: string;
  name?: string;
  email?: string;
  extraInfo?: Record<string, unknown>;
}
