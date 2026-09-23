import { mailerTemplate } from './mailer.js'
import { rsc0201Template } from './rsc0201.js'
import { lidBaseTemplate } from './lidbase.js'
import { traySleeveTemplate } from './traysleeve.js'
import { dividerTemplate } from './divider.js'
import { tuckMailerTemplate } from './tuckmailer.js'
import { tuckEndTemplate, reverseTuckTemplate, cosmeticBoxTemplate, carryHandleTemplate } from './tuckboxes.js'

export const DIELINE_TEMPLATES = Object.freeze([
  mailerTemplate, rsc0201Template, lidBaseTemplate, traySleeveTemplate, dividerTemplate,
  tuckMailerTemplate, tuckEndTemplate, reverseTuckTemplate, cosmeticBoxTemplate, carryHandleTemplate
])

export function getTemplate(id) {
  return DIELINE_TEMPLATES.find((template) => template.id === id) || null
}
