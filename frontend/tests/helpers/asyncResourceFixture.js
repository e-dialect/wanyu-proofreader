import { createAsyncResource } from '../../src/lib/asyncResource.js'

// Execute the production controller with only Vue's ref/lifecycle shell mocked.
export function asyncResourceFixture(registerDispose = () => {}) {
  return (loader, options = {}) => {
    const refs = Object.fromEntries(
      ['data', 'pending', 'error', 'hasValue', 'isEmpty'].map((key) => [key, { value: undefined }])
    )
    const resource = createAsyncResource(loader, {
      ...options,
      onChange: (state) => {
        for (const key of Object.keys(refs)) refs[key].value = state[key]
        options.onChange?.(state)
      }
    })
    for (const key of Object.keys(refs)) refs[key].value = resource.state[key]
    registerDispose(resource.dispose)
    return { ...refs, reload: resource.reload, cancel: resource.cancel }
  }
}
