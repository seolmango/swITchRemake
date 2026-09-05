import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationConfig } from '@nestjs/core/application-config';
import { NestContainer } from '@nestjs/core/injector/container';
import { Injector } from '@nestjs/core/injector/injector';
import { InstanceLoader } from '@nestjs/core/injector/instance-loader';
import { GraphInspector } from '@nestjs/core/inspector/graph-inspector';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { DependenciesScanner } from '@nestjs/core/scanner';

test('AppModule DI graph assembles without external services', async () => {
    // AppModule's ConfigModule is imported dynamically after this is set, so
    // the test never reads the repository .env (which contains real secrets).
    Object.assign(process.env, {
        SWITCH_SKIP_ENV_FILE: 'true',
        APP_ENV: 'test',
        DB_USER: 'smoke',
        DB_PASSWORD: 'smoke',
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_NAME: 'smoke',
        EMAIL_TRANSPORT: 'sink',
        SESSION_IP_HMAC_SECRET: '01234567890123456789012345678901',
        SESSION_IP_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        MFA_TOTP_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    });
    // require stays inside the test callback, after the guard above is set.
    const { AppModule } = require('./app.module');
    const applicationConfig = new ApplicationConfig();
    const container = new NestContainer(applicationConfig);
    const graphInspector = new GraphInspector(container);
    const scanner = new DependenciesScanner(
        container,
        new MetadataScanner(),
        graphInspector,
        applicationConfig,
    );

    await scanner.scan(AppModule);
    await new InstanceLoader(container, new Injector(), graphInspector)
        .createInstancesOfDependencies();

    // Deliberately stop before lifecycle hooks: RedisService, ResultWorker,
    // and SessionService must not connect to external services in this test.
    assert.ok(container.getModules().size > 0);
});
