import { getDigest, getPkgReleases } from '..';
import * as httpMock from '../../../../test/http-mock';
import { TGitTagsDatasource } from '.';

const datasource = TGitTagsDatasource.id;

describe('modules/datasource/tgit-tags/index', () => {
  describe('getReleases', () => {
    it('returns tags from custom registry', async () => {
      const body = [
        {
          name: 'v1.0.0',
          commit: {
            created_at: '2020-03-04T12:01:37.000-06:00',
          },
        },
        {
          name: 'v1.1.0',
          commit: {},
        },
        {
          name: 'v1.1.1',
        },
      ];
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/some%2Fdep2/repository/tags?per_page=100')
        .reply(200, body);
      const res = await getPkgReleases({
        datasource,
        registryUrls: ['https://tgit.company.com/api/v3/'],
        depName: 'some/dep2',
      });
      expect(res).toMatchSnapshot();
      expect(res.releases).toHaveLength(3);
    });

    it('returns tags from custom registry in sub path', async () => {
      const body = [
        {
          name: 'v1.0.0',
          commit: {
            created_at: '2020-03-04T12:01:37.000-06:00',
          },
        },
        {
          name: 'v1.1.0',
          commit: {},
        },
        {
          name: 'v1.1.1',
        },
      ];
      httpMock
        .scope('https://my.company.com/tgit')
        .get('/api/v3/projects/some%2Fdep2/repository/tags?per_page=100')
        .reply(200, body);
      const res = await getPkgReleases({
        datasource,
        registryUrls: ['https://my.company.com/tgit'],
        depName: 'some/dep2',
      });
      expect(res).toMatchSnapshot();
      expect(res?.releases).toHaveLength(3);
    });

    it('returns tags with default registry', async () => {
      const body = [{ name: 'v1.0.0' }, { name: 'v1.1.0' }];
      httpMock
        .scope('https://git.code.tencent.com')
        .get('/api/v3/projects/some%2Fdep2/repository/tags?per_page=100')
        .reply(200, body);
      const res = await getPkgReleases({
        datasource,
        depName: 'some/dep2',
      });
      expect(res).toMatchSnapshot();
      expect(res.releases).toHaveLength(2);
    });
  });

  describe('getDigest', () => {
    it('returns commits from tgit installation', async () => {
      const digest = 'abcd00001234';
      const body = [
        {
          id: digest,
        },
      ];
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/some%2Fdep2/repository/commits?per_page=1')
        .reply(200, body);
      const res = await getDigest({
        datasource,
        registryUrls: ['https://tgit.company.com/api/v3/'],
        depName: 'some/dep2',
      });
      expect(res).toBe(digest);
    });

    it('returns commits from tgit installation for a specific branch', async () => {
      const digest = 'abcd00001234';
      const body = {
        id: digest,
      };
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/some%2Fdep2/repository/commits/branch')
        .reply(200, body);
      const res = await getDigest(
        {
          datasource,
          registryUrls: ['https://tgit.company.com/api/v3/'],
          depName: 'some/dep2',
        },
        'branch'
      );
      expect(res).toBe(digest);
    });

    it('returns null from tgit installation with no commits', async () => {
      const body = [];
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/some%2Fdep2/repository/commits?per_page=1')
        .reply(200, body);
      const res = await getDigest({
        datasource,
        registryUrls: ['https://tgit.company.com/api/v3/'],
        depName: 'some/dep2',
      });
      expect(res).toBeNull();
    });

    it('returns null from tgit installation with unknown branch', async () => {
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/some%2Fdep2/repository/commits/unknown-branch')
        .reply(404, null);
      const res = await getDigest(
        {
          datasource,
          registryUrls: ['https://tgit.company.com/api/v3/'],
          depName: 'some/dep2',
        },
        'unknown-branch'
      );
      expect(res).toBeNull();
    });
  });

  describe('getRepo', () => {
    it('for x/y format', async () => {
      // httpMock
      //   .scope('https://tgit.company.com')
      //   .get('/api/v3/projects/some%2Fdep2')
      //   .reply(200, {});
      const res = await new TGitTagsDatasource().getRepo({
        registryUrl: 'https://tgit.company.com',
        packageName: 'some/dep2',
      });
      expect(res).toBe('some/dep2');
    });
    it('x/y/z package is root repo', async () => {
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/x%2Fy%2Fz')
        .reply(200, { id: 1 });
      const res = await new TGitTagsDatasource().getRepo({
        registryUrl: 'https://tgit.company.com',
        packageName: 'x/y/z',
      });
      expect(res).toBe('x/y/z');
    });

    it('x/y/z package is a dir in x/y repo', async () => {
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/x%2Fy%2Fz')
        .reply(404, { message: 'not found' });
      const res = await new TGitTagsDatasource().getRepo({
        registryUrl: 'https://tgit.company.com',
        packageName: 'x/y/z',
      });
      expect(res).toBe('x/y');
    });
    it('x/y/z/i package is a dir in x/y/z repo', async () => {
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/x%2Fy%2Fz%2Fi')
        .reply(404, { message: 'not found' });
      httpMock
        .scope('https://tgit.company.com')
        .get('/api/v3/projects/x%2Fy%2Fz')
        .reply(200, { id: 1 });
      const res = await new TGitTagsDatasource().getRepo({
        registryUrl: 'https://tgit.company.com',
        packageName: 'x/y/z/i',
      });
      expect(res).toBe('x/y/z');
    });
  });
});
