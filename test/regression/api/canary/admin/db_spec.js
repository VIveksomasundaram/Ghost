const path = require('path');
const _ = require('lodash');
const os = require('os');
const fs = require('fs-extra');
const uuid = require('uuid');
const should = require('should');
const supertest = require('supertest');
const sinon = require('sinon');
const config = require('../../../../../core/shared/config');
const {events} = require('../../../../../core/server/lib/common');
const testUtils = require('../../../../utils');
const localUtils = require('./utils');

let ghost = testUtils.startGhost;
let request;
let eventsTriggered;

describe('DB API', function () {
    let backupKey;
    let schedulerKey;

    before(function () {
        return ghost()
            .then(() => {
                request = supertest.agent(config.get('url'));
            })
            .then(() => {
                return localUtils.doAuth(request);
            })
            .then(() => {
                backupKey = _.find(testUtils.existingData.apiKeys, {integration: {slug: 'ghost-backup'}});
                schedulerKey = _.find(testUtils.existingData.apiKeys, {integration: {slug: 'ghost-scheduler'}});
            });
    });

    beforeEach(function () {
        eventsTriggered = {};

        sinon.stub(events, 'emit').callsFake((eventName, eventObj) => {
            if (!eventsTriggered[eventName]) {
                eventsTriggered[eventName] = [];
            }

            eventsTriggered[eventName].push(eventObj);
        });
    });

    afterEach(function () {
        sinon.restore();
    });

    it('can export the database with more tables', function () {
        return request.get(localUtils.API.getApiQuery('db/?include=mobiledoc_revisions'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect(200)
            .then((res) => {
                const jsonResponse = res.body;
                should.exist(jsonResponse.db);
                jsonResponse.db.should.have.length(1);
                Object.keys(jsonResponse.db[0].data).length.should.eql(29);
            });
    });

    it('can export & import', function () {
        const exportFolder = path.join(os.tmpdir(), uuid.v4());
        const exportPath = path.join(exportFolder, 'export.json');

        return request.put(localUtils.API.getApiQuery('settings/'))
            .set('Origin', config.get('url'))
            .send({
                settings: [
                    {
                        key: 'is_private',
                        value: true
                    }
                ]
            })
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200)
            .then(() => {
                return request.get(localUtils.API.getApiQuery('db/'))
                    .set('Origin', config.get('url'))
                    .expect('Content-Type', /json/)
                    .expect(200);
            })
            .then((res) => {
                const jsonResponse = res.body;
                should.exist(jsonResponse.db);

                fs.ensureDirSync(exportFolder);
                fs.writeJSONSync(exportPath, jsonResponse);

                return request.post(localUtils.API.getApiQuery('db/'))
                    .set('Origin', config.get('url'))
                    .set('Accept', 'application/json')
                    .expect('Content-Type', /json/)
                    .attach('importfile', exportPath)
                    .expect(200);
            })
            .then((res) => {
                res.body.problems.length.should.eql(3);
                fs.removeSync(exportFolder);
            });
    });

    it('fails when triggering an export from unknown filename ', function () {
        return request.get(localUtils.API.getApiQuery('db/?filename=this_file_is_not_here.json'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .expect(404);
    });

    it('import should fail without file', function () {
        return request.post(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .expect(422);
    });

    it('import should fail with unsupported file', function () {
        return request.post(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .attach('importfile', path.join(__dirname, '/../../../../utils/fixtures/csv/single-column-with-header.csv'))
            .expect(415);
    });

    it('export can be triggered by backup integration', function () {
        const backupQuery = `?filename=test`;
        const fsStub = sinon.stub(fs, 'writeFile').resolves();

        return request.post(localUtils.API.getApiQuery(`db/backup${backupQuery}`))
            .set('Authorization', `Ghost ${localUtils.getValidAdminToken('/canary/admin/', backupKey)}`)
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect(200)
            .then((res) => {
                res.body.should.be.Object();
                res.body.db[0].filename.should.match(/test\.json/);
                fsStub.calledOnce.should.eql(true);
            });
    });

    it('export can not be triggered by integration other than backup', function () {
        const fsStub = sinon.stub(fs, 'writeFile').resolves();

        return request.post(localUtils.API.getApiQuery(`db/backup`))
            .set('Authorization', `Ghost ${localUtils.getValidAdminToken('/canary/admin/', schedulerKey)}`)
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect(403)
            .then((res) => {
                should.exist(res.body.errors);
                res.body.errors[0].type.should.eql('NoPermissionError');
                fsStub.called.should.eql(false);
            });
    });

    it('export can be triggered by Admin authentication', function () {
        const fsStub = sinon.stub(fs, 'writeFile').resolves();

        return request.post(localUtils.API.getApiQuery(`db/backup`))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect(200);
    });

    it('Can import a JSON database exported from Ghost v2', async function () {
        await request.delete(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect(204);

        // preventively remove default "fixture" user
        const fixtureUserResponse = await request.get(localUtils.API.getApiQuery('users/slug/fixture/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private);

        if (fixtureUserResponse.body.users) {
            await request.delete(localUtils.API.getApiQuery(`users/${fixtureUserResponse.body.users[0].id}`))
                .set('Origin', config.get('url'))
                .set('Accept', 'application/json');
        }

        const res = await request.post(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .attach('importfile', path.join(__dirname, '/../../../../utils/fixtures/export/v2_export.json'))
            .expect(200);

        const jsonResponse = res.body;
        should.exist(jsonResponse.db);
        should.exist(jsonResponse.problems);
        jsonResponse.problems.should.have.length(2);

        const postsResponse = await request.get(localUtils.API.getApiQuery('posts/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200);

        postsResponse.body.posts.should.have.length(7);

        const usersResponse = await request.get(localUtils.API.getApiQuery('users/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200);

        usersResponse.body.users.should.have.length(3);
    });

    it('Can import a JSON database exported from Ghost 3.0', async function () {
        await request.delete(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect(204);

        // preventively remove default "fixture" user
        const fixtureUserResponse = await request.get(localUtils.API.getApiQuery('users/slug/fixture/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private);

        if (fixtureUserResponse.body.users) {
            await request.delete(localUtils.API.getApiQuery(`users/${fixtureUserResponse.body.users[0].id}`))
                .set('Origin', config.get('url'))
                .set('Accept', 'application/json');
        }

        const res = await request.post(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .attach('importfile', path.join(__dirname, '/../../../../utils/fixtures/export/v3_export.json'))
            .expect(200);

        const jsonResponse = res.body;
        should.exist(jsonResponse.db);
        should.exist(jsonResponse.problems);
        jsonResponse.problems.should.have.length(2);

        const res2 = await request.get(localUtils.API.getApiQuery('posts/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200);

        res2.body.posts.should.have.length(7);

        const usersResponse = await request.get(localUtils.API.getApiQuery('users/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200);

        usersResponse.body.users.should.have.length(3);
    });

    it('Can import a JSON database exported from Ghost 4.0', async function () {
        await request.delete(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect(204);

        // preventively remove default "fixture" user
        const fixtureUserResponse = await request.get(localUtils.API.getApiQuery('users/slug/fixture/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private);

        if (fixtureUserResponse.body.users) {
            await request.delete(localUtils.API.getApiQuery(`users/${fixtureUserResponse.body.users[0].id}`))
                .set('Origin', config.get('url'))
                .set('Accept', 'application/json');
        }

        const res = await request.post(localUtils.API.getApiQuery('db/'))
            .set('Origin', config.get('url'))
            .set('Accept', 'application/json')
            .expect('Content-Type', /json/)
            .attach('importfile', path.join(__dirname, '/../../../../utils/fixtures/export/v4_export.json'))
            .expect(200);

        const jsonResponse = res.body;
        should.exist(jsonResponse.db);
        should.exist(jsonResponse.problems);
        jsonResponse.problems.should.have.length(2);

        const res2 = await request.get(localUtils.API.getApiQuery('posts/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200);

        res2.body.posts.should.have.length(7);

        const usersResponse = await request.get(localUtils.API.getApiQuery('users/'))
            .set('Origin', config.get('url'))
            .expect('Content-Type', /json/)
            .expect('Cache-Control', testUtils.cacheRules.private)
            .expect(200);

        usersResponse.body.users.should.have.length(3);
    });
});
