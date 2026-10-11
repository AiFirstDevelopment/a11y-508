import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app.config';
import { App } from './app';
import { adoptSecretFromUrl } from './core/api';

adoptSecretFromUrl();
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
