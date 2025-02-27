/*
 * Copyright The Cryostat Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { AlertVariant } from '@patternfly/react-core';
import _ from 'lodash';
import { BehaviorSubject, combineLatest, Observable, Subject, timer } from 'rxjs';
import { fromFetch } from 'rxjs/fetch';
import { concatMap, distinctUntilChanged, filter } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import {
  NotificationMessage,
  ReadyState,
  CloseStatus,
  NotificationCategory,
  NotificationsUrlGetResponse,
} from './api.types';
import { messageKeys } from './api.utils';
import { LoginService } from './Login.service';
import { NotificationService } from './Notifications.service';
import { SessionState, AuthMethod } from './service.types';

export class NotificationChannel {
  private ws: WebSocketSubject<NotificationMessage> | null = null;
  private readonly _messages = new Subject<NotificationMessage>();
  private readonly _ready = new BehaviorSubject<ReadyState>({ ready: false });

  constructor(
    private readonly notifications: NotificationService,
    private readonly login: LoginService,
  ) {
    messageKeys.forEach((value, key) => {
      if (!value || !value.body || !value.variant) {
        return;
      }
      this.messages(key).subscribe((msg: NotificationMessage) => {
        if (!value || !value.body || !value.variant) {
          return;
        }
        const message = value.body(msg);
        this.notifications.notify({
          title: value.title,
          message,
          category: key,
          variant: value.variant,
          hidden: value.hidden,
        });
      });
    });

    // fallback handler for unknown categories of message
    this._messages
      .pipe(filter((msg) => !messageKeys.has(msg.meta.category as NotificationCategory)))
      .subscribe((msg) => {
        const category = NotificationCategory[msg.meta.category as keyof typeof NotificationCategory];
        this.notifications.notify({
          title: msg.meta.category,
          message: msg.message,
          category,
          variant: AlertVariant.success,
        });
      });

    const notificationsUrl = fromFetch(`${this.login.authority}/api/v1/notifications_url`).pipe(
      concatMap(async (resp) => {
        if (resp.ok) {
          const body: NotificationsUrlGetResponse = await resp.json();
          return body.notificationsUrl;
        } else {
          const body: string = await resp.text();
          throw new Error(resp.status + ' ' + body);
        }
      }),
    );

    combineLatest([
      notificationsUrl,
      this.login.getToken(),
      this.login.getAuthMethod(),
      this.login.getSessionState(),
      timer(0, 5000),
    ])
      .pipe(distinctUntilChanged(_.isEqual))
      .subscribe({
        next: (parts: string[]) => {
          const url = parts[0];
          const token = parts[1];
          const authMethod = parts[2];
          const sessionState = parseInt(parts[3]);
          let subprotocol: string | undefined = undefined;

          if (sessionState !== SessionState.CREATING_USER_SESSION) {
            return;
          }

          if (authMethod === AuthMethod.BEARER) {
            subprotocol = `base64url.bearer.authorization.cryostat.${token}`;
          } else if (authMethod === AuthMethod.BASIC) {
            subprotocol = `basic.authorization.cryostat.${token}`;
          }

          if (this.ws) {
            this.ws.complete();
          }

          this.ws = webSocket({
            url,
            protocol: subprotocol,
            openObserver: {
              next: () => {
                this._ready.next({ ready: true });
                this.login.setSessionState(SessionState.USER_SESSION);
              },
            },
            closeObserver: {
              next: (evt) => {
                let code: CloseStatus;
                let msg: string | undefined = undefined;
                let fn: typeof this.notifications.info;
                let sessionState: SessionState;
                switch (evt.code) {
                  case CloseStatus.LOGGED_OUT:
                    code = CloseStatus.LOGGED_OUT;
                    msg = 'Logout success';
                    fn = this.notifications.info;
                    sessionState = SessionState.NO_USER_SESSION;
                    break;
                  case CloseStatus.PROTOCOL_FAILURE:
                    code = CloseStatus.PROTOCOL_FAILURE;
                    msg = 'Authentication failed';
                    fn = this.notifications.danger;
                    sessionState = SessionState.NO_USER_SESSION;
                    break;
                  case CloseStatus.INTERNAL_ERROR:
                    code = CloseStatus.INTERNAL_ERROR;
                    msg = 'Internal server error';
                    fn = this.notifications.danger;
                    sessionState = SessionState.CREATING_USER_SESSION;
                    break;
                  default:
                    code = CloseStatus.UNKNOWN;
                    fn = this.notifications.info;
                    sessionState = SessionState.CREATING_USER_SESSION;
                    break;
                }
                this._ready.next({ ready: false, code });
                this.login.setSessionState(sessionState);
                fn.apply(this.notifications, [
                  'WebSocket connection lost',
                  msg,
                  NotificationCategory.WsClientActivity,
                  fn === this.notifications.info,
                ]);
              },
            },
          });

          this.ws.subscribe({
            next: (v) => this._messages.next(v),
            error: (err: Error) => this.logError('WebSocket error', err),
          });

          // message doesn't matter, we just need to send something to the server so that our SubProtocol token can be authenticated
          this.ws.next({ message: 'connect' } as NotificationMessage);
        },
        error: (err: Error) => this.logError('Notifications URL configuration', err),
      });

    this.login.loggedOut().subscribe({
      next: () => {
        this.ws?.complete();
      },
      error: (err: Error) => this.logError('Notifications URL configuration', err),
    });
  }

  isReady(): Observable<ReadyState> {
    return this._ready.asObservable();
  }

  messages(category: string): Observable<NotificationMessage> {
    return this._messages.asObservable().pipe(filter((msg) => msg.meta.category === category));
  }

  private logError(title: string, err: Error): void {
    console.error(`${title}:${err.message}`);
    err.stack && console.error(err.stack);
    this.notifications.danger(title, JSON.stringify(err.message));
  }
}
