import type { Session } from 'koishi';

declare module 'koishi' {
  interface Events {
    'chatluna/before-check-sender'(session: Session): boolean | void | Promise<boolean | void>;
  }
}
