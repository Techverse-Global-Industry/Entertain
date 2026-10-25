import {configureBackend} from './configuration.mjs';

export function onPreBuild({netlifyConfig,utils}) {
  try { configureBackend(netlifyConfig,process.env); } catch (error) { utils.build.failBuild(error.message); }
}
