import PocketBase from 'pocketbase'

const runtimeBackendUrl = globalThis.__FANGJI_BACKEND_URL__
const buildTimePbUrl = import.meta.env.VITE_PB_URL

const pbUrl = runtimeBackendUrl || buildTimePbUrl || window.location.origin

const pb = new PocketBase(pbUrl)

export default pb
