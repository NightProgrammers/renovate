import * as httpMock from '../../../test/http-mock';
import { PlatformId } from '../../constants';
import { EXTERNAL_HOST_ERROR } from '../../constants/error-messages';
import * as hostRules from '../host-rules';
import { TGitHttp, setBaseUrl } from './tgit';

hostRules.add({
  hostType: PlatformId.TGit,
  token: '123test',
});

const tgitApiHost = 'https://git.code.tencent.com';
const selfHostedUrl = 'https://git.woa.com';

describe('util/http/tgit', () => {
  let tgitApi: TGitHttp;

  beforeEach(() => {
    tgitApi = new TGitHttp();
    setBaseUrl(`${tgitApiHost}/api/v3/`);
    delete process.env.TGIT_IGNORE_REPO_URL;

    hostRules.add({
      hostType: PlatformId.TGit,
      token: 'abc123',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();

    hostRules.clear();
  });

  it('paginates', async () => {
    httpMock
      .scope(tgitApiHost)
      .get('/api/v3/some-url')
      .reply(200, ['a'], {
        'X-Page': '1',
        'X-Next-Page': '2',
      })
      .get('/api/v3/some-url?page=2')
      .reply(200, ['b', 'c'], {
        'X-Page': '2',
        'X-Prev-Page': '1',
        'X-Next-Page': '3',
      })
      .get('/api/v3/some-url?page=3')
      .reply(200, ['d'], {
        'X-Page': '3',
        'X-Prev-Page': '2',
      });
    const res = await tgitApi.getJson('some-url', { paginate: true });
    expect(res.body).toHaveLength(4);

    const trace = httpMock.getTrace();
    expect(trace).toHaveLength(3);
    expect(trace).toMatchSnapshot();
  });

  it('attempts to paginate', async () => {
    httpMock.scope(tgitApiHost).get('/api/v3/some-url').reply(200, ['a'], {
      'x-page': '1',
      'x-total-pages': '1',
    });
    const res = await tgitApi.getJson('some-url', { paginate: true });
    expect(res.body).toHaveLength(1);

    const trace = httpMock.getTrace();
    expect(trace).toHaveLength(1);
    expect(trace).toMatchSnapshot();
  });
  it('posts', async () => {
    const body = ['a', 'b'];
    httpMock.scope(tgitApiHost).post('/api/v3/some-url').reply(200, body);
    const res = await tgitApi.postJson('some-url');
    expect(res.body).toEqual(body);
    expect(httpMock.getTrace()).toMatchSnapshot();
  });
  it('sets baseUrl', () => {
    expect(() => setBaseUrl(`${selfHostedUrl}/api/v3/`)).not.toThrow();
  });

  describe('fails with', () => {
    it('403', async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/some-url').reply(403);
      await expect(
        tgitApi.get('some-url')
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Response code 403 (Forbidden)"`
      );
    });

    it('404', async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/some-url').reply(404);
      await expect(
        tgitApi.get('some-url')
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Response code 404 (Not Found)"`
      );
    });

    it('500', async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/some-url').reply(500);
      await expect(tgitApi.get('some-url')).rejects.toThrow(
        EXTERNAL_HOST_ERROR
      );
    });

    it('ParseError', async () => {
      httpMock.scope(tgitApiHost).get('/api/v3/some-url').reply(200, '{{');
      await expect(tgitApi.getJson('some-url')).rejects.toThrow(
        EXTERNAL_HOST_ERROR
      );
    });
  });
});
