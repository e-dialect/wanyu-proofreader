import pb from '@/lib/pocketbase'

export async function getResearchNotice() {
  return pb.send('/api/fangji/research-notice', { requestKey: null })
}

export async function chooseResearchNotice(choice) {
  return pb.send('/api/fangji/research-notice', {
    method: 'POST',
    body: { choice },
    requestKey: null
  })
}
