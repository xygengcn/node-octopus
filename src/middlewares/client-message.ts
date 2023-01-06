import Context from '@/lib/context';
import { SocketMessage, SocketMessageType } from '@/typings/message';
import { ClientMiddleware } from '@/typings/socket';

/**
 *
 *
 * 隐藏指令中间件
 *
 *
 *
 * @returns
 */
export function clientSocketMessageMiddleware(): ClientMiddleware {
    return async (ctx: Context, next) => {
        const message: SocketMessage = ctx.toJson();
        if (message && typeof message === 'object') {
            if (message.action && message.targetId === ctx.id && message.msgId) {
                // log
                ctx.debug('[message]', message);
                // 在线状态再触发，是固定消息模式
                if (ctx.client.status === 'online') {
                    ctx.client.emit('message', message);
                }

                // 自己发出request请求，别人回答了，收到回调 如果是在线状态需要校验targetId
                if (message.type === 'response') {
                    // 日志
                    ctx.log('[message-response]', '这是一条回调消息:', message.msgId);
                    // 触发请求回调
                    ctx.client.emit(message.msgId as any, message.content.developerMsg, message.content.content);
                    return;
                }

                // 收到别人的request请求，并回答它，如果是在线状态需要校验targetId
                if (message.type === 'request') {
                    // 获取执行函数
                    const event = ctx.client.getResponse(message.action);

                    // 存在回调
                    ctx.log('[message-request]', '这是一条请求消息:', message.msgId, 'event:', !!event);

                    // 结果
                    let content = null;

                    // 错误
                    let developerMsg = null;

                    // 执行函数
                    if (event && typeof event === 'function') {
                        try {
                            // 运行注册函数
                            content = await event(message.content?.content || {});
                        } catch (e: any) {
                            developerMsg = e;
                        }
                    }

                    ctx.json({
                        action: message.action,
                        msgId: message.msgId,
                        type: SocketMessageType.response,
                        content: {
                            content,
                            developerMsg
                        }
                    });
                    return;
                }
            }

            // 普通消息，不处理
            ctx.client.log('[message]', '收到消息不处理', message.msgId);
        }
        next();
    };
}
