/// <reference path="../pb_data/types.d.ts" />
cronAdd('assist-publication-cleanup', '* * * * *', () => {
  require(`${__hooks}/lib/assist_publication.js`).cleanup($app)
})
