import { clientSocketBindMiddleware } from '@/middlewares/client-bind';
import { clientMessageMiddleware } from '@/middlewares/client-message';
import clientSysMsgMiddleware from '@/middlewares/client-sys';
import { SocketMessage, SocketMessageType } from '@/typings/message';
import { ClientMiddleware, ClientSocketEvent, ClientSocketOptions, ClientSocketStatus, SocketResponseAction, SocketType } from '@/typings/socket';
import { compose, parseError, stringifyError, uuid } from '@/utils';
import { Stream } from 'amp';
import Message from 'amp-message';
import { Socket, AddressInfo } from 'net';
import Context from '../context';
import Emitter from '../emitter';
import BaseError from '../error';

/**
 * 客户端
 *
 */
export default class ClientSocket extends Emitter<ClientSocketEvent> {
    // 状态
    public status: ClientSocketStatus = 'none';

    // 对象
    public socket!: Socket;

    /**
     * 目标id
     */
    public get targetId() {
        return this.options?.targetId || '';
    }

    /**
     * 客户端id
     */
    public get clientId() {
        return this.options?.clientId || '';
    }

    /**
     * 是不是服务端的客户端
     */
    public get isServer(): boolean {
        return this.options.type === SocketType.server;
    }

    // 配置
    private options: ClientSocketOptions = { retry: true, host: '0.0.0.0', port: 31000, type: SocketType.client, clientId: 'Client', targetId: 'Server' };

    // 重连配置
    private retryTimeout: NodeJS.Timer | null = null;

    // 手动关闭
    private isManualClose = false;

    // 记录每次请求
    private clientRequestTimeoutMap: Map<string, NodeJS.Timer> = new Map();

    // 记录response的函数
    private responseAction: Map<string, SocketResponseAction> = new Map();

    // 中间件
    private middlewares: Map<string, { middlewares: ClientMiddleware[]; plugin: (_this: Context) => Promise<void> }> = new Map();

    // 构造
    constructor(options: ClientSocketOptions, socket?: Socket) {
        const namespace = `Socket-${options.type || SocketType.client}_${options.clientId}`;
        super(namespace);
        // 配置初始化
        this.configure(options);

        // 初始化
        if (socket && socket instanceof Socket) {
            this.socket = socket;
            this.status = 'binding';
            this.listenSocketEvent();
        } else {
            this.status = 'none';
            // 创建Socket
            this.socket = new Socket();
        }

        // 绑定中间件
        this.use('connect', clientSocketBindMiddleware(this.options.secret));

        // 处理消息
        this.use('data', clientMessageMiddleware());

        // 处理系统消息
        this.use('data', clientSysMsgMiddleware(this));
    }

    /**
     * 插件
     *
     * 后注册先执行
     *
     * @param hook string
     * @param middleware ClientMiddleware
     */
    public use(hook: 'data' | 'connect', middleware: ClientMiddleware) {
        if (typeof middleware !== 'function') throw new TypeError('middleware must be a function!');
        const hookMiddleware = this.middlewares.get(hook);
        const middlewares: ClientMiddleware[] = hookMiddleware?.middlewares || [];
        middlewares.unshift(middleware);
        const plugin = compose(middlewares);
        this.middlewares.set(hook, { middlewares, plugin });
    }

    /**
     * 重新设置配置
     *
     * @param options
     */
    public configure(options: Partial<Pick<ClientSocketOptions, 'targetId' | 'timeout' | 'retryDelay'>>) {
        Object.assign(this.options, options || {});
    }

    /**
     * 客户端链接
     */
    public connect(options?: Partial<ClientSocketOptions>) {
        // 更新配置
        if (options && typeof options === 'object') {
            Object.assign(this.options, options);
        }

        if (!this.options.port) {
            this.emit('error', new TypeError('port为空'));
        }

        // 在线不需要连接
        if (this.status === 'online') {
            return;
        }

        this.debug('[create-connect]', '创建连接', this.options);

        this.status = 'pending';

        // 开始链接
        this.socket.connect(this.options.port, this.options.host);

        // 链接事件
        this.socket.once('connect', () => {
            this.debug('[connect]', '连接到服务端', this.socket.address(), this.socket.localAddress);
            // 解除手动限制，手动断开后手动连接后的自动重连
            this.isManualClose = false;

            // 使用插件
            this.useHook('connect', this.socket);

            // 连接成功，删掉重连定时
            this.clearRetryTimeout();
        });

        // 绑定事件
        this.listenSocketEvent();
    }

    /**
     * 重连
     */
    public reconnect(options?: Partial<ClientSocketOptions>): void {
        // 更新配置
        if (options && typeof options === 'object') {
            Object.assign(this.options, options);
        }
        this.debug('[reconnect]', '准备重连', 'status:', this.status, 'isManualClose:', this.isManualClose);
        if (this.status === 'error' || this.status === 'offline') {
            // 回调
            this.emit('reconnect', this.socket);

            // 移除上一次
            this.socket?.unref();
            this.socket?.removeAllListeners();

            // 修改状态
            this.status = 'retrying';

            // 500ms开始链接
            setTimeout(() => {
                this.connect();
            }, 500);
        }
    }

    /**
     * 请求消息
     *
     * 俗称约定：action为socket:*为隐藏指令
     *
     *
     * @param action
     * @param params
     * @param callback
     */
    public request<T extends any = any>(action: string, params: string | number | object, callback: (error: Error | null, result: T) => void): void;
    public request<T = any>(action: string, params: string | number | object): Promise<T>;
    public async request(action, params, callback?): Promise<any> {
        // 日志
        this.log('[request]', '客户端请求，action:', action);

        if (!action || typeof action !== 'string') {
            return Promise.reject(new BaseError(30001, 'Action is required'));
        }

        // 先检测本地是否注册

        if (this.responseAction.has(action)) {
            const responseAction: SocketResponseAction = this.getResponse(action) as SocketResponseAction;
            if (typeof callback === 'function') {
                let developerMsg: Error | null = null;
                let result = null;
                try {
                    result = await responseAction(params || {});
                } catch (error: any) {
                    developerMsg = error;
                }
                callback(developerMsg, result);
                return;
            } else {
                return new Promise(async (resolve, reject) => {
                    try {
                        const result = await responseAction(params || {});
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        }

        // 正常情况,没有callback返回promise
        // 只有在线或者系统消息才能发出去
        if (this.socket && (this.status === 'online' || /^socket:.+$/i.test(action))) {
            if (typeof callback === 'function') {
                this.requestMessage(action, params, callback);
                return;
            } else {
                return new Promise((resolve, reject) => {
                    this.requestMessage(action, params, (error, result) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(result);
                        }
                    });
                });
            }
        }

        // 错误处理

        this.logError('[request]', '发送失败', 'socket状态:', this.status);

        // 返回失败
        this.emit('error', new BaseError(30002, "Socket isn't connect !"));
        if (typeof callback === 'function') {
            callback(new BaseError(30002, "Socket isn't connect !"));
        } else {
            return Promise.reject(new BaseError(30002, "Socket isn't connect !"));
        }
    }

    /**
     * 回答事件
     * @param action
     * @param callback
     */
    public response(action: string, callback: SocketResponseAction) {
        if (typeof action === 'string' && typeof callback === 'function') {
            this.responseAction.set(action, callback);
            return;
        }
        throw TypeError('Action is a string type and callback is a function');
    }

    /**
     * 断开链接
     */
    public disconnect(error?: Error) {
        if (error) {
            this.logError('[disconnect]', '客户端断开，当前状态：', this.status, '错误', error);
        } else {
            this.debug('[disconnect]', '客户端断开，当前状态：', this.status);
        }
        // 结束连接
        this.socket?.end(() => {
            this.debug('[disconnect-end-callback]');
            // 已经下线了就不会再触发
            if (this.status !== 'offline') {
                this.emit('disconnect', this.socket);
            }
        });
        this.socket?.destroy(error);
        this.isManualClose = true;
    }

    /**
     * 获取注册的动作
     * @param action
     * @returns
     */
    public getResponse(action: string): SocketResponseAction | undefined {
        return this.responseAction.get(action);
    }

    /**
     * 移除注册的动作
     * @param action
     * @returns
     */
    public removeResponse(action: string) {
        return this.responseAction.delete(action);
    }

    /**
     * 返回所有动作的keys
     * @returns
     */
    public responseKeys(): string[] {
        return Array.from(this.responseAction.keys());
    }

    /**
     * 发送消息
     * @param msg
     * @returns
     */
    public send(msg: Partial<SocketMessage>): string {
        if (!msg.action) return '';
        // 请求时间
        const requestTime = new Date().getTime();
        // 生成唯一id
        const msgId = msg.msgId || this.msgId();

        const addressInfo: AddressInfo = this.socket.address() as AddressInfo;
        // 发送内容
        const socketMessage: SocketMessage = {
            action: msg.action,
            type: msg.type || SocketMessageType.request,
            headers: {
                host: addressInfo.address,
                port: addressInfo.port
            },
            content: {
                content: msg.content?.content,
                developerMsg: stringifyError(msg.content?.developerMsg) as any
            },
            // 下面的是不能改的
            msgId,
            time: requestTime,
            targetId: this.targetId, // 接收端
            fromId: this.clientId, // 发送端
            fromType: this.options.type || SocketType.client
        };
        // 发送
        if (socketMessage.action && socketMessage.targetId) {
            this.debug('[send]', msg);
            this.emit('send', socketMessage);
            this.write(socketMessage);
            return msgId;
        } else {
            // action 和 targetId 是必要的
            this.logError('[send] action and targetId is requred', msgId, socketMessage.action, socketMessage.targetId);
        }
        return '';
    }

    /**
     * 封装发送消息
     * @param args
     */
    private requestMessage(action: string, content: string | number | object, callback: false): void;
    private requestMessage(action: string, content: string | number | object, callback: (error: Error | null, ...result: any[]) => void): void;
    private requestMessage(action, content, callback) {
        if (this.socket) {
            // 生成唯一id
            const msgId = this.msgId();

            // log
            this.log('[requestMessage]', 'action:', action, '发出消息:', msgId);

            // 存在回调
            if (callback && typeof callback === 'function') {
                // 存在计时器要清理掉
                const clearTimerEvent = () => {
                    if (this.clientRequestTimeoutMap.has(msgId)) {
                        clearTimeout(this.clientRequestTimeoutMap.get(msgId));
                        this.clientRequestTimeoutMap.delete(msgId);
                    }
                };
                // 时间超时
                const timeoutErrorEvent = () => {
                    clearTimerEvent();
                    // 回调错误
                    callback(new BaseError(30003, 'Request Timeout'));
                    this.off(msgId as any, timeoutErrorEvent);
                };
                // 建立五秒回调限制
                const eventTimeout = setTimeout(timeoutErrorEvent, this.options.timeout || 5000);

                // 保存单次请求计时器
                this.clientRequestTimeoutMap.set(msgId, eventTimeout);

                // 收到回调
                this.once(msgId as any, (error, ...result) => {
                    clearTimerEvent();
                    // 日志
                    this.log('[requestMessage]', '收到消息回调:', msgId);

                    // 需要处理错误信息
                    callback(parseError(error), ...result);
                });
            }

            // 发送
            this.send({
                content: {
                    content
                },
                action,
                msgId
            });
        }
    }

    /**
     * 消息id生成
     * @returns
     */
    private msgId(): string {
        return `${this.clientId}-${this.options.targetId}-${new Date().getTime()}-${uuid()}`;
    }

    /**
     *
     * 使用插件
     *
     * @param hook
     * @param args
     */
    private useHook<T extends string = keyof ClientSocketEvent>(hook: T, ...args: T extends keyof ClientSocketEvent ? Parameters<ClientSocketEvent[T]> : any[]): Promise<void> {
        this.emit(hook as any, ...(args as any));
        const plugin = this.middlewares.get(hook);
        if (plugin?.plugin) {
            const ctx = new Context(args[0], this);
            return plugin.plugin.call(this, ctx);
        }
        return Promise.resolve();
    }

    /**
     * 发送消息
     * @param args
     */
    private write(...args: any[]): void {
        const message = new Message(args);
        this.socket.write(message.toBuffer(), (e) => {
            if (e) {
                this.logError('[write]', '发送失败', e, ...args);
                this.emit('error', e || new BaseError(30004, 'Socket write error'));
            }
        });
    }

    /**
     * 监听事件
     */
    private listenSocketEvent() {
        this.debug('[listenSocketEvent]', '开始绑定事件');

        // 保持活跃
        this.socket.setKeepAlive(true, 500);

        // 接收来自服务端的信息
        const stream = new Stream();
        this.socket.pipe(stream);
        stream.on('data', (buf) => {
            // 日志
            this.debug('[data]', '收到消息');

            // data hook
            this.useHook('data', buf, this);
        });

        // 有错误发生调用的事件
        this.socket.on('error', (e: Error & { code: string }) => {
            // 日志
            this.logError('[error]', e);
            this.status = 'error';
            this.emit('error', e);

            if (e.code === 'ECONNREFUSED') {
                // 网络问题，重连机制
                this.autoRetryConnect();
            }
        });

        // socket关闭的事件
        this.socket.once('close', (hadError) => {
            this.debug('[close]', 'hadError:', hadError);
            // 下线
            this.handleOffline();

            // 回调
            this.emit('close', this.socket);

            this.socket.removeAllListeners();

            // 清理
            this.clearReuqestTimeoutMap();

            // 关闭触发，重连机制
            this.autoRetryConnect();
        });

        /**
         * 对方发送了关闭数据包过来的事件
         *
         * 1、手动断开服务端进程，客户端会触发
         * 2、服务端disconnect，客户端会触发
         * 3、客户端disconnect，服务端会触发
         * 4、手动断开客户端进程，服务端会触发
         *
         * 自己disconnect不会触发
         */
        this.socket.once('end', () => {
            this.debug('[end]');
            // 先下线
            this.handleOffline();

            // 再通知
            this.emit('end', this.socket);
            // 清理
            this.clearReuqestTimeoutMap();

            // 关闭触发，重连机制
            this.autoRetryConnect();
        });
    }

    /**
     * 清理请求定时器
     */
    private clearReuqestTimeoutMap() {
        this.clientRequestTimeoutMap.forEach((t: any) => {
            t && clearTimeout(t);
            t = null;
        });
        this.clientRequestTimeoutMap.clear();
    }

    /**
     * 自动重连
     *
     * retry === true
     */
    private autoRetryConnect() {
        // 错误状态，下线状态，自动配置，客户端创建连接，不是手动关闭，不在定时中
        if ((this.status === 'error' || this.status === 'offline') && this.options.retry && this.options.type === 'client' && !this.isManualClose && !this.retryTimeout) {
            this.debug('[autoRetryConnect]', '自动重连', this.status, this.options, this.isManualClose);
            this.retryTimeout = setTimeout(() => {
                this.reconnect();
                // 开始重连，删掉重连定时
                this.clearRetryTimeout();
            }, this.options.retryDelay || 3000);
        }
    }

    /**
     * 下线
     */
    private handleOffline() {
        if (this.status !== 'offline') {
            this.status = 'offline';
            // 先日志，再回调
            this.debug('[offline]');
            this.emit('offline', this.socket);
        }
    }

    /**
     * 清理重连定时器
     */
    private clearRetryTimeout() {
        this.debug('[clearRetryTimeout]');
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
    }
}
