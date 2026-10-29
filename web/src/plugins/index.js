// Built-in plugins with a client part, by id. They load only when the server says they're enabled.
import diagrams from './diagrams.js';
import math from './math.js';
import daily from './daily.js';

export const bundledPlugins = { diagrams, math, daily };
