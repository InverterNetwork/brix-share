import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app.ts';
import { readStageFile } from '../lib/stage-file.ts';
import { readStages } from '../lib/stages.ts';

const app = new App();
buildApp(app, readStages(readStageFile()));
app.synth();
