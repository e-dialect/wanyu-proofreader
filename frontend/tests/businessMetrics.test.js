import test from 'node:test'
import assert from 'node:assert/strict'
import { measureBusiness, setBusinessMetricReporter } from '../src/lib/businessMetrics.js'
test('business timings accept only fixed names and finite elapsed values', () => {
  const values = []
  setBusinessMetricReporter((name, value) => values.push([name, value]))
  measureBusiness('submit_ack', 42)
  measureBusiness('/private?token=secret', 42)
  measureBusiness('editor_ready', -1)
  measureBusiness('editor_ready', NaN)
  assert.deepEqual(values, [['submit_ack', 42]])
  setBusinessMetricReporter(null)
})
