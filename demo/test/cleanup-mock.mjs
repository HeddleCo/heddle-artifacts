// SPDX-License-Identifier: Apache-2.0
// Test-only cleanup seam, not a proposed production API route.
import { request } from '../../cli/ha.mjs';
await request(`${process.env.DEMO_URL}/__test/reset`, process.env.OPERATOR_TOKEN, { id: process.env.DEMO_PROJECT });
