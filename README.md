# BOI Key Management System (KMS)

## Overview
The Key Management System (KMS) is a secure web application for managing key assets within Beauty One International.

## Features
- 🔐 Secure authentication with JWT and session management
- 👤 Role-based access control (RBAC)
- 🔑 Key borrowing and return workflows
- 📧 Email notifications for key requests and approvals
- 📊 Admin dashboard with real-time metrics
- 📝 Audit logging with integrity validation
- 🔄 CSRF protection
- 📱 Responsive design for all devices

## Technology Stack
- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL
- **Frontend**: HTML5, CSS3, JavaScript
- **Security**: JWT, bcrypt, Helmet.js, CSRF protection

## Environment Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- npm 9+

### Installation

1. Clone the repository
\`\`\`bash
git clone https://github.com/wjlimBOI/kms.git
cd kms
\`\`\`

2. Install dependencies
\`\`\`bash
npm install
\`\`\`

3. Configure environment variables
\`\`\`bash
cp .env.example .env
# Edit .env with your configuration
\`\`\`

4. Initialize database
\`\`\`bash
npm run migrate
\`\`\`

5. Start development server
\`\`\`bash
npm run dev
\`\`\`

## Deployment

### Staging/UAT
\`\`\`bash
npm run staging
\`\`\`

### Production
\`\`\`bash
npm run production
\`\`\`

### Using PM2
\`\`\`bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
\`\`\`

## Security Features
- Password policy: Minimum 16 characters with complexity requirements
- JWT token expiration: 24 hours
- Session timeout: 30 minutes
- Brute force protection: 5 failed attempts
- CSRF protection on all state-changing requests
- Audit logging for all sensitive actions

## Contributing
1. Create a feature branch from `development`
2. Make your changes
3. Submit a pull request to `development`
4. After review, merge to `staging` for UAT
5. After UAT approval, merge to `main` for production

## License
ISC

## Contact
Beauty One International Pte Ltd
