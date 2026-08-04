/**
 * Provider wiring.
 *
 * The rest of the application injects `SUBMISSION_PROVIDER` and never names a concrete
 * class, so switching providers is a change to this factory alone. Selection is driven
 * by `PROVIDER_DRIVER` so tests and offline development can opt into the fake without
 * touching application code.
 */

import { Global, Module } from '@nestjs/common';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { FakeSubmissionProvider } from './fake/fake.provider';
import { LeetCodeProvider } from './leetcode/leetcode.provider';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from './provider.types';

@Global()
@Module({
  providers: [
    LeetCodeProvider,
    FakeSubmissionProvider,
    {
      provide: SUBMISSION_PROVIDER,
      inject: [CONFIG_TOKEN, LeetCodeProvider, FakeSubmissionProvider],
      useFactory: (
        config: AppConfig,
        leetcode: LeetCodeProvider,
        fake: FakeSubmissionProvider,
      ): SubmissionProvider => {
        const driver = (process.env.PROVIDER_DRIVER ?? 'leetcode').toLowerCase();
        if (driver === 'fake') return fake;
        // `config` participates so a future provider can be chosen from typed config
        // rather than a raw env read.
        void config;
        return leetcode;
      },
    },
  ],
  exports: [SUBMISSION_PROVIDER, LeetCodeProvider, FakeSubmissionProvider],
})
export class ProvidersModule {}
