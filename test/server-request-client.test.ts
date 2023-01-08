import assert from 'assert';
import { ClientSocket, ServerSocket } from '../src/index';

const server = new ServerSocket({ port: 3004, serverId: 'server1' });

server.start();

server.on('error', (error) => {
    console.log('[server-error]', error);
});

// 服务端注册
server.response('action/test', () => {
    return 'server1';
});

describe('服务端请求客户端测试', () => {
    after(() => {
        server.stop();
    });

    describe('单向发送', () => {
        it('服务端、客户端同时注册，服务端返回', (done) => {
            const client = new ClientSocket({ port: 3004, host: '0.0.0.0', clientId: 'client1', targetId: 'server1' });

            // 客户端注册
            client.response('action/test', (params) => {
                assert.equal(params, 'hello');
                return 'client1';
            });
            client.connect();
            client.on('online', () => {
                // 服务端请求
                server.request('action/test', 'hello').then((result) => {
                    assert.equal(result, 'server1');
                    client.disconnect();
                    done();
                });
            });
        });
        it('客户端注册，服务端请求，客户端返回', (done) => {
            const client = new ClientSocket({ port: 3004, host: '0.0.0.0', clientId: 'client2', targetId: 'server1' });
            // 客户端注册
            client.response('client/response', (params) => {
                assert.equal(params, 'hello');
                return 'client2';
            });
            client.connect();
            client.on('online', () => {
                // 服务端请求
                server
                    .request('client/response', 'hello')
                    .then((result) => {
                        assert.equal(result, 'client2');
                        client.disconnect();
                        done();
                    })
                    .catch((e) => {
                        assert.ok(0, e);
                        client.disconnect();
                        done(e);
                    });
            });
        });
        // it('客户端注册，客户端离线，服务端请求，请求失败', (done) => {});
    });
});
