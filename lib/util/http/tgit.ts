import is from '@sindresorhus/is';
import { PlatformId } from '../../constants';
import { logger } from '../../logger';
import { ExternalHostError } from '../../types/errors/external-host-error';
import { resolveBaseUrl } from '../url';
import type { HttpHeaders, HttpResponse, InternalHttpOptions } from './types';
import { Http } from '.';

let baseUrl = 'https://git.code.tencent.com/api/v3';
export const setBaseUrl = (url: string): void => {
  baseUrl = url;
};

interface TGitInternalOptions extends InternalHttpOptions {
  body?: string;
}

export interface TGitHttpHeaders extends HttpHeaders {
  // 项目总数
  'x-total'?: string | undefined;
  //总页数
  'x-total-pages'?: string | undefined;
  //	每页的项目数
  'x-per-page'?: string | undefined;
  // 当前页面的索引(从1开始)
  'x-page'?: string | undefined;
  // 下一页的索引
  'x-next-page'?: string | undefined;
  // 上一页的索引
  'x-prev-page'?: string | undefined;
}

interface TGitPageNode {
  cur: number;
  prev?: number;
  next?: number;
}

export interface TGitHttpOptions extends InternalHttpOptions {
  paginate?: boolean;
  token?: string;
}

function parsePageNode(headers: TGitHttpHeaders): TGitPageNode {
  const cur = headers['x-page'];
  const next = headers['x-next-page'];
  const prev = headers['x-prev-page'];
  if (!cur) {
    return null;
  }

  const ret: TGitPageNode = {
    cur: parseInt(cur),
  };
  if (next) {
    ret.next = parseInt(next);
  }
  if (prev) {
    ret.prev = parseInt(prev);
  }

  return ret;
}

export class TGitHttp extends Http<TGitHttpOptions, TGitHttpOptions> {
  constructor(type: string = PlatformId.TGit, options?: TGitHttpOptions) {
    super(type, options);
  }

  protected override async request<T>(
    url: string | URL,
    options?: TGitInternalOptions & TGitHttpOptions
  ): Promise<HttpResponse<T>> {
    const opts = {
      baseUrl,
      ...options,
      throwHttpErrors: true,
    };

    try {
      const result = await super.request<T>(url, opts);
      logger.warn(result.body);
      logger.warn(result.headers);
      const pn = parsePageNode(result.headers);
      if (opts.paginate && is.array(result.body) && pn && pn.next) {
        const resolvedUrl = new URL(
          resolveBaseUrl(options?.baseUrl ?? baseUrl, url)
        );
        resolvedUrl.searchParams.set('page', pn.next.toString());
        resolvedUrl.href;

        const nextResult = await this.request(resolvedUrl.toString(), opts);
        if (is.array(nextResult.body)) {
          result.body.push(...nextResult.body);
        }
      }

      return result;
    } catch (err) {
      throw handleGotError(err, url, opts);
    }
  }
}

function handleGotError(
  err: any,
  url: string | URL,
  opts: TGitHttpOptions
): Error {
  if (err.statusCode === 404) {
    logger.trace({ err }, 'TGit 404');
    logger.debug({ url: err.url }, 'TGit API 404');
    throw err;
  }
  logger.debug({ err }, 'TGit API error');
  if (
    err.statusCode === 429 ||
    (err.statusCode >= 500 && err.statusCode < 600)
  ) {
    throw new ExternalHostError(err, PlatformId.Gitlab);
  }

  if (err.name === 'ParseError') {
    throw new ExternalHostError(err, PlatformId.Gitlab);
  }
  throw err;
}
