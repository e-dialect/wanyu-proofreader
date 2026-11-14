import pb from '@/lib/pocketbase'

export function listSources({ signal } = {}) {
  return pb.send('/api/fangji/sources', { method: 'GET', requestKey: null, signal })
}

export function getSource(reference, { signal } = {}) {
  return pb.send(`/api/fangji/sources/${encodeURIComponent(reference)}`, {
    method: 'GET',
    requestKey: null,
    signal
  })
}

export function createSource(body) {
  return pb.send('/api/fangji/sources', { method: 'POST', body, requestKey: null })
}

export function updateSource(sourceId, body, { signal } = {}) {
  return pb.send('/api/fangji/sources/' + encodeURIComponent(sourceId), {
    method: 'PATCH',
    body,
    requestKey: null,
    signal
  })
}

export function saveSourceUsage(sourceId, purpose, body, { signal } = {}) {
  return pb.send(
    `/api/fangji/sources/${encodeURIComponent(sourceId)}/usages/${encodeURIComponent(purpose)}`,
    {
      method: 'PUT',
      body,
      requestKey: null,
      signal
    }
  )
}
