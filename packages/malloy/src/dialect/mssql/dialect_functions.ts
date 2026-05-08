/*
 * Copyright 2026 Light Labs.
 *
 * Licensed under the MIT license. See LICENSE in the project root.
 */

import type {
  DefinitionBlueprintMap,
  OverloadedDefinitionBlueprint,
} from '../functions/util';
import {def} from '../functions/util';

// MSSQL STRING_AGG uses WITHIN GROUP (ORDER BY ...) which doesn't fit the
// inline ${order_by:} template. Order-by support is omitted for MVP.
const string_agg: OverloadedDefinitionBlueprint = {
  default_separator: {
    takes: {'value': {dimension: 'string'}},
    returns: {measure: 'string'},
    impl: {sql: "STRING_AGG(${value}, ',')"},
  },
  with_separator: {
    takes: {
      'value': {dimension: 'string'},
      'separator': {literal: 'string'},
    },
    returns: {measure: 'string'},
    impl: {sql: 'STRING_AGG(${value}, ${separator})'},
  },
};

export const MSSQL_DIALECT_FUNCTIONS: DefinitionBlueprintMap = {
  string_agg,
  ...def('repeat', {'str': 'string', 'n': 'number'}, 'string'),
  ...def('reverse', {'str': 'string'}, 'string'),
};
