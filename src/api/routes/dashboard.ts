import _ from 'lodash';
import axios from 'axios';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import { getCredit } from '@/api/controllers/core.ts';

function getSessionUserId(request: Request): number | null {
  const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
  return sessionId ? db.validateSession(sessionId) : null;
}

function assertDashboardSession(request: Request) {
  const userId = getSessionUserId(request);
  if (!userId) return new Response({ error: '未登录' }, { statusCode: 401 });
  return null;
}

function formatMediaRecord(item: any) {
  return {
    ...item,
    preview_url: `/dashboard/media/${item.id}/preview`,
    source_url: item.url,
    status: item.url ? 'saved' : 'missing',
  };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default {
  prefix: '/dashboard',

  get: {
    // 检查是否需要初始化设置
    '/status': async (request: Request) => {
      return {
        setupComplete: db.isSetupComplete(),
        authenticated: !!getSessionUserId(request)
      };
    },

    // 获取统计数据
    '/stats': async (request: Request) => {
      const unauthorized = assertDashboardSession(request);
      if (unauthorized) return unauthorized;
      return db.getStats();
    },

    // 获取日志
    '/logs': async (request: Request) => {
      const unauthorized = assertDashboardSession(request);
      if (unauthorized) return unauthorized;
      const level = request.query.level as string;
      const limit = parseInt(request.query.limit as string) || 100;
      return db.getLogs(level, limit);
    },

    // 获取媒体列表（分页）
    '/media': async (request: Request) => {
      const unauthorized = assertDashboardSession(request);
      if (unauthorized) return unauthorized;
      const page = parseInt(request.query.page as string) || 1;
      const limit = parseInt(request.query.limit as string) || 20;
      const type = request.query.type as string;
      const result = db.getMedia(page, limit, type);
      return {
        ...result,
        items: result.items.map(formatMediaRecord),
      };
    },

    // 通过服务端代理预览媒体，规避远程防盗链导致的前端坏图
    '/media/:id/preview': async (request: Request) => {
      const unauthorized = assertDashboardSession(request);
      if (unauthorized) return unauthorized;

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return new Response({ error: '媒体记录不存在' }, { statusCode: 404 });
      }

      const item = db.getMediaById(id) as any;
      if (!item || !item.url || !isHttpUrl(item.url)) {
        return new Response({ error: '媒体记录不可预览' }, { statusCode: 404 });
      }

      try {
        const upstream = await axios.get(item.url, {
          responseType: 'stream',
          timeout: 12000,
          maxRedirects: 5,
          headers: {
            Accept: item.type === 'video' ? 'video/*,*/*' : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            Referer: 'https://jimeng.jianying.com/',
            Origin: 'https://jimeng.jianying.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
          },
          validateStatus: status => status >= 200 && status < 400,
        });

        return new Response(upstream.data, {
          type: upstream.headers['content-type'] || (item.type === 'video' ? 'video/mp4' : 'image/webp'),
          headers: {
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (e) {
        return new Response(
          { error: '预览加载失败', message: e.message },
          { statusCode: 502 }
        );
      }
    },

    // 获取指定Key的积分
    '/credits': async (request: Request) => {
      const unauthorized = assertDashboardSession(request);
      if (unauthorized) return unauthorized;
      const key = request.query.key as string;
      if (!key) {
        return { error: '缺少Key参数' };
      }
      try {
        const credits = await getCredit(key);
        return credits;
      } catch (e) {
        return { error: '查询失败', message: e.message };
      }
    }
  },

  post: {
    // 初始化设置账号密码
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) {
        return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      }
      const { username, password } = request.body;
      if (!username || !password) {
        return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      }
      if (password.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },

    // 登录
    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) {
        return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      }
      const sessionId = db.createSession(userId);
      return new Response(
        { success: true },
        { 
          statusCode: 200,
          headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` }
        }
      );
    },

    // 登出
    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (sessionId) {
        db.deleteSession(sessionId);
      }
      return new Response(
        { success: true },
        { 
          statusCode: 200,
          headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' }
        }
      );
    },

    // 修改密码
    '/password': async (request: Request) => {
      const userId = getSessionUserId(request);
      if (!userId) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    }
  },

  delete: {
    // 清理日志
    '/logs': async (request: Request) => {
      const unauthorized = assertDashboardSession(request);
      if (unauthorized) return unauthorized;
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    }
  }
};
