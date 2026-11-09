migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  for (const [key, oldPath, newPath] of [
    ["resetPasswordTemplate", "/_/#/auth/confirm-password-reset/{TOKEN}", "/account/reset-password#token={TOKEN}"],
    ["confirmEmailChangeTemplate", "/_/#/auth/confirm-email-change/{TOKEN}", "/account/confirm-email#token={TOKEN}"],
    ["verificationTemplate", "/_/#/auth/confirm-verification/{TOKEN}", "/account/verify-email#token={TOKEN}"]
  ]) users[key].body = users[key].body.split(oldPath).join(newPath)
  app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("users")
  for (const [key, oldPath, newPath] of [
    ["resetPasswordTemplate", "/_/#/auth/confirm-password-reset/{TOKEN}", "/account/reset-password#token={TOKEN}"],
    ["confirmEmailChangeTemplate", "/_/#/auth/confirm-email-change/{TOKEN}", "/account/confirm-email#token={TOKEN}"],
    ["verificationTemplate", "/_/#/auth/confirm-verification/{TOKEN}", "/account/verify-email#token={TOKEN}"]
  ]) users[key].body = users[key].body.split(newPath).join(oldPath)
  app.save(users)
})
