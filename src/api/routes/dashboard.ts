import _ from 'lodash';
import axios from 'axios';
import fs from 'fs-extra';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import { getCredit } from '@/api/controllers/core.ts';
import { getStoredMediaPath } from '@/lib/media-storage.ts';

function formatMediaRecord(item: any) {
  return {
    ...item,
    preview_url: `/dashboard/media/${item.id}/preview`,
    source_url: item.url,
    stored_locally: Boolean(item.local_path),
    status: item.local_path ? 'stored' : item.url ? 'remote' : 'missing',
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
    // 获取统计数据
    '/stats': async (request: Request) => {
      return db.getStats();
    },

    // 获取日志
    '/logs': async (request: Request) => {
      const level = request.query.level as string;
      const limit = parseInt(request.query.limit as string) || 100;
      return db.getLogs(level, limit);
    },

    // 获取媒体列表（分页）
    '/media': async (request: Request) => {
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
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return new Response({ error: '媒体记录不存在' }, { statusCode: 404 });
      }

      const item = db.getMediaById(id) as any;
      if (!item) {
        return new Response({ error: '媒体记录不可预览' }, { statusCode: 404 });
      }

      const localPath = getStoredMediaPath(item.local_path);
      if (item.local_path && !localPath) db.clearMediaStorage(id);
      if (localPath) {
        try {
          const stat = await fs.stat(localPath);
          if (stat.isFile()) {
            return new Response(fs.createReadStream(localPath), {
              type: item.content_type || (item.type === 'video' ? 'video/mp4' : 'image/jpeg'),
              size: stat.size,
              headers: {
                'Cache-Control': 'private, max-age=3600',
                'X-Content-Type-Options': 'nosniff',
              },
            });
          }
        } catch {
          // 文件被手动删除时回退到远程地址，并清理失效的本地记录
        }
        db.clearMediaStorage(id);
      }

      if (!item.url || !isHttpUrl(item.url)) {
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

  delete: {
    // 清理日志
    '/logs': async (request: Request) => {
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    }
  }
};
