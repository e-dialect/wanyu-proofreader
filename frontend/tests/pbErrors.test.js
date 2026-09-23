import test from 'node:test'
import assert from 'node:assert/strict'
import { getPbMessage, getUploadErrorMessage } from '../src/utils/pbErrors.js'

test('upload 413 errors show the PDF and CSV limits instead of proxy error messages', () => {
  for (const error of [
    { status: 413, message: 'Request Entity Too Large' },
    { response: { status: 413, message: 'Request Entity Too Large' } }
  ]) {
    assert.equal(getUploadErrorMessage(error, 'pdf'), 'PDF 文件超过 100 MiB 上限')
    assert.equal(getUploadErrorMessage(error, 'csv'), 'CSV 文件超过 50 MiB 上限')
  }
})

test('other upload errors preserve server validation messages and existing fallbacks', () => {
  const error = { status: 400, response: { message: '文件内容不是有效的 PDF。' } }
  assert.equal(getUploadErrorMessage(error, 'pdf'), '文件内容不是有效的 PDF。')
  assert.equal(getUploadErrorMessage({}, 'pdf'), '上传失败，请重试')
  assert.equal(getUploadErrorMessage({}, 'csv'), '导入失败，请检查文件格式')
})

test('PDF upload conflicts explain the active session or server limit', () => {
  assert.equal(getUploadErrorMessage({ status: 429, response: { message: '已有上传进行中，请取消或完成后再试。' } }, 'pdf'), '已有上传进行中，请取消或完成后再试。')
  assert.match(getUploadErrorMessage({ status: 429 }, 'pdf'), /稍后重试/)
  assert.equal(getUploadErrorMessage({ status: 409, response: { message: '与未完成上传的文件不一致，请选择原来的 PDF 或取消后重新上传。' } }, 'pdf'), '与未完成上传的文件不一致，请选择原来的 PDF 或取消后重新上传。')
  assert.match(getUploadErrorMessage({ status: 410 }, 'pdf'), /过期/)
})

test('uses PocketBase field validation details when available', () => {
  assert.equal(getPbMessage({
    response: {
      message: 'Failed to create record.',
      data: {
        admin: { message: '关联的管理员账号不存在' },
        name: { message: '项目名称不能为空' }
      }
    }
  }, '创建失败'), '关联的管理员账号不存在；项目名称不能为空')
})

test('replaces generic PocketBase messages with the localized fallback', () => {
  assert.equal(getPbMessage({
    message: 'Failed to create record.',
    response: { message: 'Failed to create record.', data: {} }
  }, '创建失败，请重新登录后重试'), '创建失败，请重新登录后重试')
})

test('preserves useful server messages', () => {
  assert.equal(getPbMessage({
    response: { message: '该条目已被其他校对员处理', data: {} }
  }, '提交失败'), '该条目已被其他校对员处理')
})

 test('proxy disconnects explain upload timeouts without masking PDF validation', () => {
  for (const status of [400, 408, 502, 504]) {
    assert.match(getUploadErrorMessage({status}, 'pdf'), /超时/)
  }
  assert.equal(getUploadErrorMessage({status:400,response:{message:'PDF 结构损坏'}}, 'pdf'), 'PDF 结构损坏')
})
